import { and, eq, inArray } from 'drizzle-orm';
import { isActiveStatus, type CollectionExport, type CollectionStatus, type CollectionView, type CommonSettings, type CollectionSummary } from '@imaginator/core';
import { nowIso, type Tx } from '../db/index.js';
import { collections, generations } from '../db/schema.js';
import { conflict, invalid, notFound } from '../errors.js';
import { addColumnTx } from './columns.js';
import { loadAssetsById, loadCollection, requireCollection, toAsset, touchCollection, transact, type Emit, type ServiceContext } from './context.js';
import { addRowsTx } from './rows.js';
import { buildCollectionView, buildSummaries } from './view.js';

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
        for (const c of src.columns) addColumnTx(ctx, tx, emit, newSlug, c, true);
        if (src.rows.length > 0) {
          addRowsTx(
            tx,
            emit,
            newSlug,
            src.rows.map((r) => ({ ...r, id: undefined })),
            { keepIds: src.rows.map((r) => r.id) },
          );
        }
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
        // FKs are ON UPDATE CASCADE: columns, rows and generations follow.
        tx.update(collections).set({ slug: newSlug, updatedAt: nowIso() }).where(eq(collections.slug, slug)).run();
        emit({ type: 'collection.deleted', collection: slug });
        emit({ type: 'collection.created', collection: newSlug });
      });
      return view(newSlug);
    },

    export(slug: string): CollectionExport {
      const c = requireCollection(ctx.db, slug);
      const assetRows = loadAssetsById(ctx.db, c.rows.flatMap((r) => r.inputs.map((i) => i.asset)));
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
        exportedAt: nowIso(),
      };
    },

    import(document: CollectionExport, opts: { slug?: string; status?: CollectionStatus } = {}): CollectionView {
      const slug = opts.slug ?? document.collection.slug;
      transact(ctx, (tx, emit) => {
        const needed = new Set(document.rows.flatMap((r) => r.inputs.map((i) => i.asset)));
        const found = loadAssetsById(tx, needed);
        const missing = [...needed].filter((id) => !found.has(id));
        if (missing.length > 0) throw invalid(`referenced input assets are not present locally: ${missing.join(', ')}`);
        insertCollectionTx(tx, emit, {
          slug,
          title: document.collection.title,
          ...(document.collection.description !== undefined ? { description: document.collection.description } : {}),
          status: opts.status ?? document.collection.status,
          defaults: document.collection.defaults,
        });
        const cols = [...document.columns].sort((a, b) => a.position - b.position);
        for (const c of cols) addColumnTx(ctx, tx, emit, slug, { ...c, position: undefined }, true);
        const rs = [...document.rows].sort((a, b) => a.position - b.position);
        if (rs.length > 0) {
          addRowsTx(
            tx,
            emit,
            slug,
            rs.map((r) => ({ ...r, position: undefined })),
            { keepIds: rs.map((r) => r.id) },
          );
        }
      });
      return view(slug);
    },

    /** Block until the collection's cursor moves past `cursor` (and no reconcile pass is pending), or timeout. */
    async wait(slug: string, cursor: string, timeoutMs = 30_000): Promise<{ cursor: string; changed: boolean; inFlight: number; queued: number }> {
      if (!loadCollection(ctx.db, slug)) throw notFound(`collection ${slug}`);
      const deadline = Date.now() + timeoutMs;
      let changed = false;
      for (;;) {
        await ctx.hooks.reconcileSettled?.(slug);
        if (ctx.bus.isPast(slug, cursor)) {
          changed = true;
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await ctx.bus.waitForChange(slug, remaining);
      }
      const counts = ctx.db
        .select({ status: generations.status })
        .from(generations)
        .where(and(eq(generations.collection, slug), inArray(generations.status, ['queued', 'submitting', 'running', 'downloading'])))
        .all();
      const queued = counts.filter((g) => g.status === 'queued').length;
      return { cursor: ctx.bus.cursor(slug), changed, inFlight: counts.length - queued, queued };
    },

    touch(slug: string): void {
      touchCollection(ctx.db, slug);
    },
  };
}

export type CollectionService = ReturnType<typeof createCollectionService>;
