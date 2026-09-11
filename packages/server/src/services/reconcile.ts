import { eq } from 'drizzle-orm';
import { isActiveStatus } from '@imaginator/core';
import { nowIso } from '../db/index.js';
import { generations, type GenerationRow } from '../db/schema.js';
import { insertGeneration, transact, type ServiceContext } from './context.js';
import { Workbook } from './resolver.js';

export interface ReconcileResult {
  /** New generations (queued or unsupported). */
  inserted: GenerationRow[];
  /** Queued generations cancelled at once (superseded, paused, blocked, or skipped). */
  cancelled: string[];
  /** Submitted generations whose hash is no longer desired; the engine attempts remote cancellation. */
  superseded: GenerationRow[];
}

/**
 * One reconcile pass for a collection (DESIGN §4.1), in one transaction.
 * Every cell is resolved through the workbook resolver (references may read
 * other collections). A cell is satisfied when a non-cancelled generation
 * with the desired hash exists; otherwise, when the scope is live and no
 * execution hold applies, one is inserted. Blocked and skipped cells insert
 * nothing. Superseded queued work is cancelled here; superseded submitted
 * work is returned for the engine to cancel remotely.
 */
export function reconcileCollectionTx(ctx: ServiceContext, slug: string): ReconcileResult {
  return transact(ctx, (tx, emit) => {
    const result: ReconcileResult = { inserted: [], cancelled: [], superseded: [] };
    const wb = new Workbook(ctx, tx);
    const collection = wb.grid(slug);
    if (!collection) return result;

    for (const row of collection.rows) {
      for (const column of collection.columns) {
        const target = { collection: slug, row: row.id, column: column.id };
        const { resolved, selection } = wb.state(target)!;
        const live = collection.status === 'live' && !row.paused;
        const desired = !resolved.skipped && !resolved.blocked;

        for (const g of wb.cellGenerations(target)) {
          if (!isActiveStatus(g.status)) continue;
          const stale = !desired || g.requestHash !== resolved.hash;
          if (g.status === 'queued' && (stale || !live)) {
            tx.update(generations).set({ status: 'cancelled', finishedAt: nowIso() }).where(eq(generations.id, g.id)).run();
            emit({ type: 'generation.updated', id: g.id, collection: slug, row: row.id, column: column.id, status: 'cancelled' });
            result.cancelled.push(g.id);
          } else if (stale) {
            result.superseded.push(g);
          }
        }

        if (live && desired && !selection.latest && !selection.held) {
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
