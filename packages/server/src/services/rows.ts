import { and, asc, eq, inArray } from 'drizzle-orm';
import { isActiveStatus, isRef, referenceTarget, type Input, type Row, type RowInput } from '@imaginator/core';
import type { Tx } from '../db/index.js';
import { collections, columns, generations, rows } from '../db/schema.js';
import { invalid, notFound } from '../errors.js';
import { loadAssetsById, loadCollection, requireCollection, requireRowRow, toRow, touchCollection, transact, type Emit, type ServiceContext } from './context.js';
import { assertNoCycles, assertUnreferenced, rewriteRefs } from './refs.js';

function orderedIds(tx: Tx, slug: string): string[] {
  return tx.select({ id: rows.id }).from(rows).where(eq(rows.collection, slug)).orderBy(asc(rows.position), asc(rows.id)).all().map((r) => r.id);
}

function renumber(tx: Tx, slug: string, order: string[]): void {
  order.forEach((id, i) => {
    tx.update(rows).set({ position: i }).where(and(eq(rows.collection, slug), eq(rows.id, id))).run();
  });
}

export function assertAssetsExist(tx: Tx, inputs: Input[] | undefined): void {
  const ids = (inputs ?? []).flatMap((i) => (isRef(i) ? [] : [i.asset]));
  if (ids.length === 0) return;
  const found = loadAssetsById(tx, ids);
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) throw invalid(`input asset(s) not found: ${[...new Set(missing)].join(', ')}`);
}

/**
 * Every reference must point at a cell that exists: the row, the column when
 * named, and the collection when named. Same-collection targets may also be
 * rows or columns created earlier in the same batch (`extra`). A cell may not
 * reference itself.
 */
export function assertReferenceTargets(
  tx: Tx,
  slug: string,
  origin: { row?: string; column?: string },
  inputs: Input[] | undefined,
  extra: { rows?: string[]; columns?: string[] } = {},
): void {
  const local = loadCollection(tx, slug);
  const localRows = new Set([...(local?.rows.map((r) => r.id) ?? []), ...(extra.rows ?? [])]);
  const localColumns = new Set([...(local?.columns.map((c) => c.id) ?? []), ...(extra.columns ?? [])]);
  for (const input of inputs ?? []) {
    if (!isRef(input)) continue;
    const target = referenceTarget(input, { collection: slug, row: origin.row ?? '*', column: origin.column ?? '*' });
    if (target.collection === slug) {
      if (input.row !== undefined && !localRows.has(input.row)) throw invalid(`referenced row ${input.row} not found`);
      if (input.column !== undefined && !localColumns.has(input.column)) throw invalid(`referenced column ${input.column} not found`);
      if (input.row !== undefined && input.column !== undefined && input.row === origin.row && input.column === origin.column) {
        throw invalid(`cell ${slug}/${input.row}/${input.column} cannot reference itself`);
      }
      if (origin.row !== undefined && input.row === origin.row && input.column === undefined) throw invalid(`row ${origin.row} cannot reference itself`);
      if (origin.column !== undefined && input.column === origin.column && input.row === undefined) throw invalid(`column ${origin.column} cannot reference itself`);
    } else {
      const other = loadCollection(tx, target.collection);
      if (!other) throw invalid(`referenced collection ${target.collection} not found`);
      if (!other.rows.some((r) => r.id === target.row)) throw invalid(`referenced row ${target.collection}/${target.row} not found`);
      if (!other.columns.some((c) => c.id === target.column)) throw invalid(`referenced column ${target.collection}/${target.column} not found`);
    }
  }
}

function assertColumnsExist(tx: Tx, slug: string, ids: string[] | undefined | null): void {
  if (!ids) return;
  const known = new Set(tx.select({ id: columns.id }).from(columns).where(eq(columns.collection, slug)).all().map((c) => c.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) throw invalid(`column(s) not found: ${missing.join(', ')}`);
}

/** After any structural write: rebuild the reference index and refuse cycles. */
export function finishStructuralWrite(tx: Tx, slug: string): void {
  rewriteRefs(tx, slug);
  assertNoCycles(tx, slug);
}

/** Insert rows inside an existing transaction; ids come from the collection's counter. */
export function addRowsTx(tx: Tx, emit: Emit, slug: string, inputs: RowInput[], opts: { keepIds?: string[]; skipChecks?: boolean } = {}): Row[] {
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
  inputs.forEach((input, i) => {
    assertAssetsExist(tx, input.inputs);
    if (!opts.skipChecks) {
      assertReferenceTargets(tx, slug, { row: ids[i]! }, input.inputs, { rows: ids });
      assertColumnsExist(tx, slug, input.columns);
    }
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
        columns: input.columns ?? null,
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
  finishStructuralWrite(tx, slug);
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
        columns?: string[] | null;
        notes?: string | null;
        position?: number;
      },
    ): { row: Row; cursor: string } {
      const row = transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        requireRowRow(tx, slug, rowId);
        const set: Partial<typeof rows.$inferInsert> = {};
        let structural = false;
        if (patch.prompt !== undefined) set.prompt = patch.prompt;
        if (patch.negativePrompt !== undefined) set.negativePrompt = patch.negativePrompt;
        if (patch.inputs !== undefined) {
          assertAssetsExist(tx, patch.inputs);
          assertReferenceTargets(tx, slug, { row: rowId }, patch.inputs);
          set.inputs = patch.inputs;
          structural = true;
        }
        if (patch.settings !== undefined) set.settings = patch.settings;
        if (patch.columns !== undefined) {
          assertColumnsExist(tx, slug, patch.columns);
          set.columns = patch.columns;
          structural = true;
        }
        if (patch.notes !== undefined) set.notes = patch.notes;
        if (Object.keys(set).length > 0) tx.update(rows).set(set).where(and(eq(rows.collection, slug), eq(rows.id, rowId))).run();
        if (patch.position !== undefined) {
          const order = orderedIds(tx, slug).filter((id) => id !== rowId);
          order.splice(Math.min(patch.position, order.length), 0, rowId);
          renumber(tx, slug, order);
        }
        touchCollection(tx, slug);
        if (structural) finishStructuralWrite(tx, slug);
        emit({ type: 'row.updated', collection: slug, row: rowId });
        return toRow(requireRowRow(tx, slug, rowId));
      });
      return { row, cursor: ctx.bus.cursor(slug) };
    },

    remove(slug: string, ids: string[]): { cursor: string } {
      const active = transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        for (const id of ids) requireRowRow(tx, slug, id);
        for (const id of ids) assertUnreferenced(tx, { collection: slug, row: id }, { rows: ids }, `row ${id}`);
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
        rewriteRefs(tx, slug);
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
            ...(src.columns ? { columns: src.columns } : {}),
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
