import { isActiveStatus, resolveCell, type CellAddress, type CellView, type Generation, type GenerationSummary } from '@imaginator/core';
import type { GenerationRow } from '../db/schema.js';
import { conflict, notFound } from '../errors.js';
import { assetLookupFor, insertGeneration, requireCollection, toGeneration, transact, type ServiceContext } from './context.js';
import type { GenerationService } from './generations.js';
import { buildCellView, loadCellHistory } from './view.js';

function summary(g: GenerationRow): GenerationSummary {
  const full = toGeneration(g);
  return {
    id: full.id,
    version: full.version,
    requestHash: full.requestHash,
    status: full.status,
    outputs: full.outputs,
    ...(full.error ? { error: full.error } : {}),
    forced: full.forced,
    attempt: full.attempt,
    timing: full.timing,
    ...(full.cost !== undefined ? { cost: full.cost } : {}),
  };
}

export function createCellService(ctx: ServiceContext, gens: GenerationService) {
  function locate(addr: CellAddress) {
    const collection = requireCollection(ctx.db, addr.collection);
    const row = collection.rows.find((r) => r.id === addr.row);
    if (!row) throw notFound(`row ${addr.collection}/${addr.row}`);
    const column = collection.columns.find((c) => c.id === addr.column);
    if (!column) throw notFound(`column ${addr.collection}/${addr.column}`);
    return { collection, row, column };
  }

  function insertForced(addr: CellAddress, forced: boolean, allowed: (current: GenerationRow | undefined) => void): Generation {
    const inserted = transact(ctx, (tx, emit) => {
      const collection = requireCollection(tx, addr.collection);
      const row = collection.rows.find((r) => r.id === addr.row);
      const column = collection.columns.find((c) => c.id === addr.column);
      if (!row) throw notFound(`row ${addr.collection}/${addr.row}`);
      if (!column) throw notFound(`column ${addr.collection}/${addr.column}`);
      if (collection.status === 'paused') throw conflict(`collection ${addr.collection} is paused`);
      if (row.paused) throw conflict(`row ${addr.collection}/${addr.row} is paused`);
      const resolved = resolveCell(collection, row, column, { registry: ctx.registry, asset: assetLookupFor(tx, collection) });
      const history = loadCellHistory(tx, addr.collection, addr.row, addr.column);
      const current = history.find((g) => g.status !== 'cancelled' && g.requestHash === resolved.hash);
      allowed(current);
      return insertGeneration(tx, emit, {
        collection: addr.collection,
        row: addr.row,
        column: addr.column,
        requestHash: resolved.hash,
        request: resolved.request,
        unsupported: resolved.unsupported,
        forced,
      });
    });
    return toGeneration(inserted);
  }

  return {
    get(addr: CellAddress): { cell: CellView; current?: Generation; versions: GenerationSummary[]; cursor: string } {
      const { collection, row, column } = locate(addr);
      const history = loadCellHistory(ctx.db, addr.collection, addr.row, addr.column);
      const cell = buildCellView(ctx, collection, row, column, history, assetLookupFor(ctx.db, collection));
      const current = cell.generation ? history.find((g) => g.id === cell.generation) : undefined;
      return {
        cell,
        ...(current ? { current: toGeneration(current) } : {}),
        versions: history.filter((g) => g.status !== 'cancelled').map(summary),
        cursor: ctx.bus.cursor(addr.collection),
      };
    },

    /** "Give me another one": a new generation with the same hash, forced. */
    regenerate(addr: CellAddress): { generation: Generation; cursor: string } {
      const generation = insertForced(addr, true, (current) => {
        if (current?.status === 'unsupported') throw conflict(`cell is unsupported: ${current.error?.message ?? ''}`);
      });
      return { generation, cursor: ctx.bus.cursor(addr.collection) };
    },

    /** Retry a failed / unsupported / needs_attention cell with a fresh generation. */
    retry(addr: CellAddress): { generation: Generation; cursor: string } {
      const generation = insertForced(addr, false, (current) => {
        if (current && !['failed', 'unsupported', 'needs_attention'].includes(current.status)) {
          throw conflict(`cell is ${current.status}; only failed, unsupported, or needs_attention cells can be retried`);
        }
      });
      return { generation, cursor: ctx.bus.cursor(addr.collection) };
    },

    /**
     * Cancel the in-flight generation of a cell. Queued work is cancelled at
     * once; submitted work only when the provider confirms (DESIGN §4.1).
     */
    async cancel(addr: CellAddress): Promise<{ generation?: Generation; cursor: string }> {
      locate(addr);
      const history = loadCellHistory(ctx.db, addr.collection, addr.row, addr.column);
      const active = history.find((g) => isActiveStatus(g.status));
      if (!active) return { cursor: ctx.bus.cursor(addr.collection) };
      if (active.status === 'queued') {
        gens.markCancelled(active.id, ['queued']);
      } else if (active.providerRef) {
        const provider = ctx.registry.providerFor(active.request.model);
        if (provider?.cancel) {
          const outcome = await provider.cancel(active.providerRef);
          if (outcome === 'confirmed' && gens.markCancelled(active.id)) {
            ctx.hooks.abortGenerations?.([active.id], 'cancelled');
          }
        }
      }
      const after = gens.getRow(active.id);
      return { ...(after ? { generation: toGeneration(after) } : {}), cursor: ctx.bus.cursor(addr.collection) };
    },
  };
}

export type CellService = ReturnType<typeof createCellService>;
