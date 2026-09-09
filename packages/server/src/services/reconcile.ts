import { eq } from 'drizzle-orm';
import { isActiveStatus, resolveCell } from '@imaginator/core';
import { nowIso } from '../db/index.js';
import { generations, type GenerationRow } from '../db/schema.js';
import { assetLookupFor, insertGeneration, loadCollection, transact, type ServiceContext } from './context.js';
import { cellKey } from './view.js';

export interface ReconcileResult {
  /** New generations (queued or unsupported). */
  inserted: GenerationRow[];
  /** Queued generations cancelled at once (superseded or paused). */
  cancelled: string[];
  /** Submitted generations whose hash is no longer desired; the engine attempts remote cancellation. */
  superseded: GenerationRow[];
}

/**
 * One reconcile pass for a collection (DESIGN §4.1), in one transaction.
 * For every row × column: satisfied when a non-cancelled generation with the
 * desired hash exists; otherwise insert one (live collection, unpaused row).
 * Superseded queued work is cancelled here; superseded submitted work is
 * returned for the engine to cancel remotely.
 */
export function reconcileCollectionTx(ctx: ServiceContext, slug: string): ReconcileResult {
  return transact(ctx, (tx, emit) => {
    const result: ReconcileResult = { inserted: [], cancelled: [], superseded: [] };
    const collection = loadCollection(tx, slug);
    if (!collection) return result;
    const assetOf = assetLookupFor(tx, collection);

    const all = tx.select().from(generations).where(eq(generations.collection, slug)).all();
    const byCell = new Map<string, GenerationRow[]>();
    for (const g of all) {
      if (g.status === 'cancelled') continue;
      const k = cellKey(g.row, g.column);
      let list = byCell.get(k);
      if (!list) byCell.set(k, (list = []));
      list.push(g);
    }

    for (const row of collection.rows) {
      for (const column of collection.columns) {
        const live = collection.status === 'live' && !row.paused;
        const resolved = resolveCell(collection, row, column, { registry: ctx.registry, asset: assetOf });
        const gens = byCell.get(cellKey(row.id, column.id)) ?? [];
        const satisfied = gens.some((g) => g.requestHash === resolved.hash);

        for (const g of gens) {
          if (!isActiveStatus(g.status)) continue;
          const stale = g.requestHash !== resolved.hash;
          if (g.status === 'queued' && (stale || !live)) {
            tx.update(generations).set({ status: 'cancelled', finishedAt: nowIso() }).where(eq(generations.id, g.id)).run();
            emit({ type: 'generation.updated', id: g.id, collection: slug, row: row.id, column: column.id, status: 'cancelled' });
            result.cancelled.push(g.id);
          } else if (stale) {
            result.superseded.push(g);
          }
        }

        if (live && !satisfied) {
          result.inserted.push(
            insertGeneration(tx, emit, {
              collection: slug,
              row: row.id,
              column: column.id,
              requestHash: resolved.hash,
              request: resolved.request,
              unsupported: resolved.unsupported,
              forced: false,
            }),
          );
        }
      }
    }
    return result;
  });
}
