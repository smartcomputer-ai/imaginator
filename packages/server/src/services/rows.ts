import { and, asc, eq, inArray } from 'drizzle-orm';
import { isActiveStatus, isRowRef, referencedRows, type Input, type Row, type RowInput } from '@imaginator/core';
import type { Tx } from '../db/index.js';
import { collections, generations, rows } from '../db/schema.js';
import { conflict, invalid, notFound } from '../errors.js';
import { loadAssetsById, requireCollection, requireRowRow, toRow, touchCollection, transact, type Emit, type ServiceContext } from './context.js';

function orderedIds(tx: Tx, slug: string): string[] {
  return tx.select({ id: rows.id }).from(rows).where(eq(rows.collection, slug)).orderBy(asc(rows.position), asc(rows.id)).all().map((r) => r.id);
}

function renumber(tx: Tx, slug: string, order: string[]): void {
  order.forEach((id, i) => {
    tx.update(rows).set({ position: i }).where(and(eq(rows.collection, slug), eq(rows.id, id))).run();
  });
}

function assertAssetsExist(tx: Tx, inputs: Input[] | undefined): void {
  const ids = (inputs ?? []).flatMap((i) => (isRowRef(i) ? [] : [i.asset]));
  if (ids.length === 0) return;
  const found = loadAssetsById(tx, ids);
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) throw invalid(`input asset(s) not found: ${[...new Set(missing)].join(', ')}`);
}

/** Row id → ids it references, for every row in the collection. */
function referenceGraph(tx: Tx, slug: string): Map<string, string[]> {
  const list = tx.select({ id: rows.id, inputs: rows.inputs }).from(rows).where(eq(rows.collection, slug)).all();
  return new Map(list.map((r) => [r.id, referencedRows(r.inputs)]));
}

/**
 * Row references must point at rows of the same collection (existing, or
 * earlier in the same batch), never at the row itself, and never form a cycle.
 * `graph` is the collection's reference graph with this batch applied.
 */
function assertReferencesValid(graph: Map<string, string[]>, rowId: string, inputs: Input[] | undefined): void {
  for (const ref of referencedRows(inputs ?? [])) {
    if (ref === rowId) throw invalid(`row ${rowId} cannot reference itself`);
    if (!graph.has(ref)) throw invalid(`referenced row ${ref} not found`);
  }
  // Walk downstream from the referenced rows; reaching rowId again is a cycle.
  const stack = [...referencedRows(inputs ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of graph.get(id) ?? []) {
      if (next === rowId) throw invalid(`row ${rowId} and row ${id} would reference each other`);
      stack.push(next);
    }
  }
}

/** Insert rows inside an existing transaction; ids come from the collection's counter. */
export function addRowsTx(tx: Tx, emit: Emit, slug: string, inputs: RowInput[], opts: { keepIds?: string[] } = {}): Row[] {
  const coll = tx.select({ nextRow: collections.nextRow }).from(collections).where(eq(collections.slug, slug)).get();
  if (!coll) throw notFound(`collection ${slug}`);
  let next = coll.nextRow;
  const order = orderedIds(tx, slug);
  const created: string[] = [];
  // Ids first, so a batch (create, import, duplicate) may reference rows within itself.
  const ids = inputs.map((_, i) => {
    const kept = opts.keepIds?.[i];
    if (kept) {
      next = Math.max(next, Number(kept.slice(1)) + 1);
      return kept;
    }
    return `r${next++}`;
  });
  const graph = referenceGraph(tx, slug);
  inputs.forEach((input, i) => graph.set(ids[i]!, referencedRows(input.inputs ?? [])));
  inputs.forEach((input, i) => {
    assertAssetsExist(tx, input.inputs);
    assertReferencesValid(graph, ids[i]!, input.inputs);
  });
  inputs.forEach((input, i) => {
    const id = ids[i]!;
    const position = Math.min(input.position ?? order.length, order.length);
    tx.insert(rows)
      .values({
        collection: slug,
        id,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt ?? null,
        inputs: input.inputs ?? [],
        settings: input.settings ?? null,
        paused: input.paused ?? false,
        position,
        notes: input.notes ?? null,
      })
      .run();
    order.splice(position, 0, id);
    created.push(id);
  });
  tx.update(collections).set({ nextRow: next }).where(eq(collections.slug, slug)).run();
  renumber(tx, slug, order);
  touchCollection(tx, slug);
  for (const id of created) emit({ type: 'row.updated', collection: slug, row: id });
  return created.map((id) => toRow(requireRowRow(tx, slug, id)));
}

function setPaused(ctx: ServiceContext, slug: string, ids: string[], paused: boolean): { rows: Row[]; cursor: string } {
  const result = transact(ctx, (tx, emit) => {
    requireCollection(tx, slug);
    for (const id of ids) requireRowRow(tx, slug, id);
    tx.update(rows).set({ paused }).where(and(eq(rows.collection, slug), inArray(rows.id, ids))).run();
    touchCollection(tx, slug);
    for (const id of ids) emit({ type: 'row.updated', collection: slug, row: id });
    return ids.map((id) => toRow(requireRowRow(tx, slug, id)));
  });
  return { rows: result, cursor: ctx.bus.cursor(slug) };
}

export function createRowService(ctx: ServiceContext) {
  return {
    add(slug: string, inputs: RowInput[]): { rows: Row[]; cursor: string } {
      const created = transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        return addRowsTx(tx, emit, slug, inputs);
      });
      return { rows: created, cursor: ctx.bus.cursor(slug) };
    },

    update(
      slug: string,
      rowId: string,
      patch: {
        prompt?: string;
        negativePrompt?: string | null;
        inputs?: Row['inputs'];
        settings?: Row['settings'] | null;
        notes?: string | null;
        position?: number;
      },
    ): { row: Row; cursor: string } {
      const row = transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        requireRowRow(tx, slug, rowId);
        const set: Partial<typeof rows.$inferInsert> = {};
        if (patch.prompt !== undefined) set.prompt = patch.prompt;
        if (patch.negativePrompt !== undefined) set.negativePrompt = patch.negativePrompt;
        if (patch.inputs !== undefined) {
          assertAssetsExist(tx, patch.inputs);
          const graph = referenceGraph(tx, slug);
          graph.set(rowId, referencedRows(patch.inputs));
          assertReferencesValid(graph, rowId, patch.inputs);
          set.inputs = patch.inputs;
        }
        if (patch.settings !== undefined) set.settings = patch.settings;
        if (patch.notes !== undefined) set.notes = patch.notes;
        if (Object.keys(set).length > 0) tx.update(rows).set(set).where(and(eq(rows.collection, slug), eq(rows.id, rowId))).run();
        if (patch.position !== undefined) {
          const order = orderedIds(tx, slug).filter((id) => id !== rowId);
          order.splice(Math.min(patch.position, order.length), 0, rowId);
          renumber(tx, slug, order);
        }
        touchCollection(tx, slug);
        emit({ type: 'row.updated', collection: slug, row: rowId });
        return toRow(requireRowRow(tx, slug, rowId));
      });
      return { row, cursor: ctx.bus.cursor(slug) };
    },

    remove(slug: string, ids: string[]): { cursor: string } {
      const active = transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        for (const id of ids) requireRowRow(tx, slug, id);
        const removing = new Set(ids);
        for (const [id, refs] of referenceGraph(tx, slug)) {
          if (removing.has(id)) continue;
          const hit = refs.find((r) => removing.has(r));
          if (hit) throw conflict(`row ${hit} is referenced by row ${id}; change or remove that row first`);
        }
        const activeIds = tx
          .select({ id: generations.id, status: generations.status })
          .from(generations)
          .where(and(eq(generations.collection, slug), inArray(generations.row, ids)))
          .all()
          .filter((g) => isActiveStatus(g.status))
          .map((g) => g.id);
        tx.delete(rows).where(and(eq(rows.collection, slug), inArray(rows.id, ids))).run();
        renumber(tx, slug, orderedIds(tx, slug));
        touchCollection(tx, slug);
        for (const id of ids) emit({ type: 'row.deleted', collection: slug, row: id });
        return activeIds;
      });
      if (active.length > 0) ctx.hooks.abortGenerations?.(active, 'row deleted');
      return { cursor: ctx.bus.cursor(slug) };
    },

    reorder(slug: string, order: string[]): { rows: Row[]; cursor: string } {
      const result = transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        const existing = orderedIds(tx, slug);
        const known = new Set(existing);
        for (const id of order) if (!known.has(id)) throw notFound(`row ${slug}/${id}`);
        const seen = new Set<string>();
        const final = [...order.filter((id) => !seen.has(id) && seen.add(id)), ...existing.filter((id) => !seen.has(id))];
        renumber(tx, slug, final);
        touchCollection(tx, slug);
        for (const id of final) emit({ type: 'row.updated', collection: slug, row: id });
        return requireCollection(tx, slug).rows;
      });
      return { rows: result, cursor: ctx.bus.cursor(slug) };
    },

    pause: (slug: string, ids: string[]) => setPaused(ctx, slug, ids, true),

    resume(slug: string, ids: string[]): { rows: Row[]; cursor: string } {
      const result = setPaused(ctx, slug, ids, false);
      void ctx.hooks.reconcileNow?.(slug);
      return result;
    },

    duplicate(slug: string, rowId: string): { row: Row; cursor: string } {
      const row = transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        const src = toRow(requireRowRow(tx, slug, rowId));
        const [copy] = addRowsTx(tx, emit, slug, [
          {
            prompt: src.prompt,
            ...(src.negativePrompt !== undefined ? { negativePrompt: src.negativePrompt } : {}),
            inputs: src.inputs,
            ...(src.settings ? { settings: src.settings } : {}),
            paused: src.paused,
            ...(src.notes !== undefined ? { notes: src.notes } : {}),
            position: src.position + 1,
          },
        ]);
        return copy!;
      });
      return { row, cursor: ctx.bus.cursor(slug) };
    },
  };
}

export type RowService = ReturnType<typeof createRowService>;
