import { and, eq, inArray } from 'drizzle-orm';
import { isActiveStatus, isRef, type CollectionExport, type CollectionStatus, type CollectionView, type CommonSettings, type CollectionSummary, type Input } from '@imaginator/core';
import { nowIso, type Tx } from '../db/index.js';
import { collections, columns, generations, refs, rows } from '../db/schema.js';
import { conflict, invalid, notFound } from '../errors.js';
import { addColumnTx } from './columns.js';
import { loadAssetsById, loadCollection, requireCollection, toAsset, touchCollection, transact, type Emit, type ServiceContext } from './context.js';
import { assertUnreferenced, dependentCollections, referencedCollections, rewriteRefs } from './refs.js';
import { addRowsTx, assertReferenceTargets, finishStructuralWrite } from './rows.js';
import { buildCollectionView, buildSummaries } from './view.js';

/** Rewrite `collection: old` → `new` inside an input list. */
function retarget(inputs: Input[], from: string, to: string): Input[] {
  return inputs.map((i) => (isRef(i) && i.collection === from ? { ...i, collection: to } : i));
}

export interface CreateCollectionInput {
  slug: string;
  title?: string;
  description?: string;
  status?: CollectionStatus;
  defaults?: CommonSettings;
  columns?: Parameters<typeof addColumnTx>[4][];
  rows?: Parameters<typeof addRowsTx>[3];
}

function insertCollectionTx(tx: Tx, emit: Emit, input: CreateCollectionInput): void {
  if (tx.select({ slug: collections.slug }).from(collections).where(eq(collections.slug, input.slug)).get()) {
    throw conflict(`collection ${input.slug} already exists`);
  }
  const now = nowIso();
  tx.insert(collections)
    .values({
      slug: input.slug,
      title: input.title ?? input.slug,
      description: input.description ?? null,
      status: input.status ?? 'live',
      defaults: input.defaults ?? {},
      nextRow: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  emit({ type: 'collection.created', collection: input.slug });
}

export function createCollectionService(ctx: ServiceContext) {
  const view = (slug: string): CollectionView => buildCollectionView(ctx, ctx.db, slug);

  return {
    list(): CollectionSummary[] {
      return buildSummaries(ctx, ctx.db);
    },

    get: view,

    exists(slug: string): boolean {
      return !!ctx.db.select({ slug: collections.slug }).from(collections).where(eq(collections.slug, slug)).get();
    },

    create(input: CreateCollectionInput): CollectionView {
      transact(ctx, (tx, emit) => {
        insertCollectionTx(tx, emit, input);
        for (const c of input.columns ?? []) addColumnTx(ctx, tx, emit, input.slug, c);
        if (input.rows && input.rows.length > 0) addRowsTx(tx, emit, input.slug, input.rows);
      });
      return view(input.slug);
    },

    update(slug: string, patch: { title?: string; description?: string | null; defaults?: CommonSettings }): CollectionView {
      transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        const set: Partial<typeof collections.$inferInsert> = { updatedAt: nowIso() };
        if (patch.title !== undefined) set.title = patch.title;
        if (patch.description !== undefined) set.description = patch.description;
        if (patch.defaults !== undefined) set.defaults = patch.defaults;
        tx.update(collections).set(set).where(eq(collections.slug, slug)).run();
        emit({ type: 'collection.updated', collection: slug });
      });
      return view(slug);
    },

    delete(slug: string): { ok: true } {
      const active = transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        assertUnreferenced(tx, { collection: slug }, { collections: [slug] }, `collection ${slug}`);
        const activeIds = tx
          .select({ id: generations.id, status: generations.status })
          .from(generations)
          .where(eq(generations.collection, slug))
          .all()
          .filter((g) => isActiveStatus(g.status))
          .map((g) => g.id);
        tx.delete(collections).where(eq(collections.slug, slug)).run();
        emit({ type: 'collection.deleted', collection: slug });
        return activeIds;
      });
      if (active.length > 0) ctx.hooks.abortGenerations?.(active, 'collection deleted');
      return { ok: true };
    },

    setStatus(slug: string, status: CollectionStatus): CollectionView {
      transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        tx.update(collections).set({ status, updatedAt: nowIso() }).where(eq(collections.slug, slug)).run();
        emit({ type: 'collection.updated', collection: slug });
      });
      if (status === 'live') void ctx.hooks.reconcileNow?.(slug);
      return view(slug);
    },

    /** Collections referenced by this one, and collections that reference it. */
    dependencies(slug: string): { upstream: string[]; dependents: string[] } {
      requireCollection(ctx.db, slug);
      return { upstream: referencedCollections(ctx.db, slug), dependents: dependentCollections(ctx.db, slug) };
    },

    duplicate(slug: string, newSlug: string, opts: { title?: string; status?: CollectionStatus } = {}): CollectionView {
      transact(ctx, (tx, emit) => {
        const src = requireCollection(tx, slug);
        insertCollectionTx(tx, emit, {
          slug: newSlug,
          title: opts.title ?? `${src.title} (copy)`,
          ...(src.description !== undefined ? { description: src.description } : {}),
          status: opts.status ?? 'paused',
          defaults: src.defaults,
        });
        // Columns and rows may reference each other within the copy; check once at the end.
        for (const c of src.columns) addColumnTx(ctx, tx, emit, newSlug, c, true, { skipChecks: true });
        if (src.rows.length > 0) {
          addRowsTx(
            tx,
            emit,
            newSlug,
            src.rows.map((r) => ({ ...r, id: undefined })),
            { keepIds: src.rows.map((r) => r.id), skipChecks: true },
          );
        }
        for (const c of src.columns) assertReferenceTargets(tx, newSlug, { column: c.id }, c.inputs);
        for (const r of src.rows) assertReferenceTargets(tx, newSlug, { row: r.id }, r.inputs);
        finishStructuralWrite(tx, newSlug);
      });
      return view(newSlug);
    },

    rename(slug: string, newSlug: string): CollectionView {
      transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        if (newSlug === slug) return;
        if (tx.select({ slug: collections.slug }).from(collections).where(eq(collections.slug, newSlug)).get()) {
          throw conflict(`collection ${newSlug} already exists`);
        }
        // FKs are ON UPDATE CASCADE: columns, rows, generations, pins and holds follow.
        tx.update(collections).set({ slug: newSlug, updatedAt: nowIso() }).where(eq(collections.slug, slug)).run();
        // References into this collection are written by others; rewrite them and their index entries.
        const referrers = dependentCollections(tx, slug);
        for (const other of referrers) {
          for (const r of tx.select().from(rows).where(eq(rows.collection, other)).all()) {
            tx.update(rows).set({ inputs: retarget(r.inputs, slug, newSlug) }).where(and(eq(rows.collection, other), eq(rows.id, r.id))).run();
          }
          for (const c of tx.select().from(columns).where(eq(columns.collection, other)).all()) {
            if (c.inputs) tx.update(columns).set({ inputs: retarget(c.inputs, slug, newSlug) }).where(and(eq(columns.collection, other), eq(columns.id, c.id))).run();
          }
        }
        tx.update(refs).set({ toCollection: newSlug }).where(eq(refs.toCollection, slug)).run();
        rewriteRefs(tx, newSlug);
        emit({ type: 'collection.deleted', collection: slug });
        emit({ type: 'collection.created', collection: newSlug });
        for (const other of referrers) emit({ type: 'collection.updated', collection: other });
      });
      return view(newSlug);
    },

    export(slug: string): CollectionExport {
      const c = requireCollection(ctx.db, slug);
      const assetRows = loadAssetsById(
        ctx.db,
        [...c.rows.flatMap((r) => r.inputs), ...c.columns.flatMap((col) => col.inputs ?? [])].flatMap((i) => (isRef(i) ? [] : [i.asset])),
      );
      const dependencies = referencedCollections(ctx.db, slug);
      return {
        version: 1,
        collection: {
          slug: c.slug,
          title: c.title,
          ...(c.description !== undefined ? { description: c.description } : {}),
          status: c.status,
          defaults: c.defaults,
        },
        columns: c.columns,
        rows: c.rows,
        assets: [...assetRows.values()].map(toAsset),
        ...(dependencies.length > 0 ? { dependencies } : {}),
        exportedAt: nowIso(),
      };
    },

    import(document: CollectionExport, opts: { slug?: string; status?: CollectionStatus } = {}): CollectionView {
      const slug = opts.slug ?? document.collection.slug;
      transact(ctx, (tx, emit) => {
        const needed = new Set([...document.rows.flatMap((r) => r.inputs), ...document.columns.flatMap((c) => c.inputs ?? [])].flatMap((i) => (isRef(i) ? [] : [i.asset])));
        const found = loadAssetsById(tx, needed);
        const missing = [...needed].filter((id) => !found.has(id));
        if (missing.length > 0) throw invalid(`referenced input assets are not present locally: ${missing.join(', ')}`);
        for (const dep of document.dependencies ?? []) {
          if (dep !== slug && !loadCollection(tx, dep)) throw invalid(`referenced collection ${dep} is not present locally`);
        }
        insertCollectionTx(tx, emit, {
          slug,
          title: document.collection.title,
          ...(document.collection.description !== undefined ? { description: document.collection.description } : {}),
          status: opts.status ?? document.collection.status,
          defaults: document.collection.defaults,
        });
        const cols = [...document.columns].sort((a, b) => a.position - b.position);
        const from = document.collection.slug;
        for (const c of cols) addColumnTx(ctx, tx, emit, slug, { ...c, position: undefined, ...(c.inputs ? { inputs: retarget(c.inputs, from, slug) } : {}) }, true, { skipChecks: true });
        const rs = [...document.rows].sort((a, b) => a.position - b.position);
        if (rs.length > 0) {
          addRowsTx(
            tx,
            emit,
            slug,
            rs.map((r) => ({ ...r, position: undefined, inputs: retarget(r.inputs, from, slug) })),
            { keepIds: rs.map((r) => r.id), skipChecks: true },
          );
        }
        const imported = requireCollection(tx, slug);
        for (const c of imported.columns) assertReferenceTargets(tx, slug, { column: c.id }, c.inputs);
        for (const r of imported.rows) assertReferenceTargets(tx, slug, { row: r.id }, r.inputs);
        finishStructuralWrite(tx, slug);
      });
      return view(slug);
    },

    /**
     * Block until the collection's cursor moves past `cursor` and no reconcile
     * pass is pending for it or its upstream collections, or timeout. Returns
     * the dependency-aware progress (DESIGN §5).
     */
    async wait(slug: string, cursor: string, timeoutMs = 30_000) {
      if (!loadCollection(ctx.db, slug)) throw notFound(`collection ${slug}`);
      const deadline = Date.now() + timeoutMs;
      let changed = false;
      for (;;) {
        await ctx.hooks.reconcileSettled?.(slug);
        for (const up of referencedCollections(ctx.db, slug)) await ctx.hooks.reconcileSettled?.(up);
        if (ctx.bus.isPast(slug, cursor)) {
          changed = true;
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await ctx.bus.waitForChange(slug, remaining);
      }
      const v = view(slug);
      return { cursor: v.cursor, changed, inFlight: v.inFlight, queued: v.queued, progress: v.progress };
    },

    touch(slug: string): void {
      touchCollection(ctx.db, slug);
    },
  };
}

export type CollectionService = ReturnType<typeof createCollectionService>;
