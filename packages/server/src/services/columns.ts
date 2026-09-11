import { and, asc, eq } from 'drizzle-orm';
import { isActiveStatus, slugify, type Column, type ColumnInput, type Input } from '@imaginator/core';
import type { Tx } from '../db/index.js';
import { columns, generations } from '../db/schema.js';
import { conflict, invalid, notFound } from '../errors.js';
import { requireColumnRow, requireCollection, toColumn, touchCollection, transact, type Emit, type ServiceContext } from './context.js';
import { assertUnreferenced, rewriteRefs } from './refs.js';
import { assertAssetsExist, assertReferenceTargets, finishStructuralWrite } from './rows.js';

/** Default column id: the model's short name (after the `/`), de-duplicated with -2, -3, ... */
export function defaultColumnId(model: string, taken: Set<string>): string {
  const base = slugify(model.slice(model.indexOf('/') + 1)) || 'column';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function renumber(tx: Tx, slug: string, order: string[]): void {
  order.forEach((id, i) => {
    tx.update(columns).set({ position: i }).where(and(eq(columns.collection, slug), eq(columns.id, id))).run();
  });
}

function orderedIds(tx: Tx, slug: string): string[] {
  return tx.select({ id: columns.id }).from(columns).where(eq(columns.collection, slug)).orderBy(asc(columns.position), asc(columns.id)).all().map((c) => c.id);
}

function checkRecipeInputs(tx: Tx, slug: string, columnId: string, inputs: Input[] | undefined | null, extraColumns: string[] = []): void {
  if (!inputs) return;
  assertAssetsExist(tx, inputs);
  assertReferenceTargets(tx, slug, { column: columnId }, inputs, { columns: extraColumns });
}

/** Insert a column inside an existing transaction. `allowUnknownModel` for import/duplicate. */
export function addColumnTx(
  ctx: ServiceContext,
  tx: Tx,
  emit: Emit,
  slug: string,
  input: ColumnInput,
  allowUnknownModel = false,
  opts: { skipChecks?: boolean } = {},
): Column {
  if (!allowUnknownModel && !ctx.registry.has(input.model)) throw invalid(`unknown model ${input.model}`);
  const existing = orderedIds(tx, slug);
  const taken = new Set(existing);
  const id = input.id ?? defaultColumnId(input.model, taken);
  if (taken.has(id)) throw conflict(`column ${id} already exists in ${slug}`);
  if (!opts.skipChecks) checkRecipeInputs(tx, slug, id, input.inputs, [id]);
  const position = Math.min(input.position ?? existing.length, existing.length);
  tx.insert(columns)
    .values({
      collection: slug,
      id,
      model: input.model,
      settings: input.settings ?? null,
      count: input.count ?? 1,
      position,
      prompt: input.prompt ?? null,
      negativePrompt: input.negativePrompt ?? null,
      inputs: input.inputs ?? null,
    })
    .run();
  const order = [...existing];
  order.splice(position, 0, id);
  renumber(tx, slug, order);
  touchCollection(tx, slug);
  finishStructuralWrite(tx, slug);
  emit({ type: 'column.updated', collection: slug, column: id });
  return toColumn(requireColumnRow(tx, slug, id));
}

export function createColumnService(ctx: ServiceContext) {
  return {
    add(slug: string, input: ColumnInput): { column: Column; cursor: string } {
      const column = transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        return addColumnTx(ctx, tx, emit, slug, input);
      });
      return { column, cursor: ctx.bus.cursor(slug) };
    },

    update(
      slug: string,
      columnId: string,
      patch: {
        id?: string;
        model?: string;
        settings?: Record<string, unknown> | null;
        count?: number;
        position?: number;
        prompt?: string | null;
        negativePrompt?: string | null;
        inputs?: Input[] | null;
      },
    ): { column: Column; cursor: string } {
      const column = transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        requireColumnRow(tx, slug, columnId);
        if (patch.model !== undefined && !ctx.registry.has(patch.model)) throw invalid(`unknown model ${patch.model}`);
        const set: Partial<typeof columns.$inferInsert> = {};
        let structural = false;
        if (patch.model !== undefined) set.model = patch.model;
        if (patch.settings !== undefined) set.settings = patch.settings === null ? null : (patch.settings as never);
        if (patch.count !== undefined) set.count = patch.count;
        if (patch.prompt !== undefined) set.prompt = patch.prompt;
        if (patch.negativePrompt !== undefined) set.negativePrompt = patch.negativePrompt;
        if (patch.inputs !== undefined) {
          checkRecipeInputs(tx, slug, columnId, patch.inputs);
          set.inputs = patch.inputs;
          structural = true;
        }
        let newId = columnId;
        if (patch.id !== undefined && patch.id !== columnId) {
          if (tx.select({ id: columns.id }).from(columns).where(and(eq(columns.collection, slug), eq(columns.id, patch.id))).get()) {
            throw conflict(`column ${patch.id} already exists in ${slug}`);
          }
          // References name columns by id; a rename would leave them dangling.
          assertUnreferenced(tx, { collection: slug, column: columnId }, {}, `column ${columnId} cannot be renamed while it`);
          set.id = patch.id;
          newId = patch.id;
          structural = true;
        }
        if (Object.keys(set).length > 0) {
          tx.update(columns).set(set).where(and(eq(columns.collection, slug), eq(columns.id, columnId))).run();
        }
        if (patch.position !== undefined) {
          const order = orderedIds(tx, slug).filter((id) => id !== newId);
          order.splice(Math.min(patch.position, order.length), 0, newId);
          renumber(tx, slug, order);
        }
        touchCollection(tx, slug);
        if (structural) finishStructuralWrite(tx, slug);
        if (newId !== columnId) emit({ type: 'column.deleted', collection: slug, column: columnId });
        emit({ type: 'column.updated', collection: slug, column: newId });
        return toColumn(requireColumnRow(tx, slug, newId));
      });
      return { column, cursor: ctx.bus.cursor(slug) };
    },

    remove(slug: string, columnId: string): { cursor: string } {
      const active = transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        requireColumnRow(tx, slug, columnId);
        assertUnreferenced(tx, { collection: slug, column: columnId }, { columns: [columnId] }, `column ${columnId}`);
        const activeIds = tx
          .select({ id: generations.id, status: generations.status })
          .from(generations)
          .where(and(eq(generations.collection, slug), eq(generations.column, columnId)))
          .all()
          .filter((g) => isActiveStatus(g.status))
          .map((g) => g.id);
        tx.delete(columns).where(and(eq(columns.collection, slug), eq(columns.id, columnId))).run();
        renumber(tx, slug, orderedIds(tx, slug));
        touchCollection(tx, slug);
        rewriteRefs(tx, slug);
        emit({ type: 'column.deleted', collection: slug, column: columnId });
        return activeIds;
      });
      if (active.length > 0) ctx.hooks.abortGenerations?.(active, 'column deleted');
      return { cursor: ctx.bus.cursor(slug) };
    },

    reorder(slug: string, order: string[]): { columns: Column[]; cursor: string } {
      const cols = transact(ctx, (tx, emit) => {
        requireCollection(tx, slug);
        const existing = orderedIds(tx, slug);
        const known = new Set(existing);
        for (const id of order) if (!known.has(id)) throw notFound(`column ${slug}/${id}`);
        const seen = new Set<string>();
        const final = [...order.filter((id) => !seen.has(id) && seen.add(id)), ...existing.filter((id) => !seen.has(id))];
        renumber(tx, slug, final);
        touchCollection(tx, slug);
        for (const id of final) emit({ type: 'column.updated', collection: slug, column: id });
        return requireCollection(tx, slug).columns;
      });
      return { columns: cols, cursor: ctx.bus.cursor(slug) };
    },
  };
}

export type ColumnService = ReturnType<typeof createColumnService>;
