import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  ACTIVE_STATUSES,
  type Generation,
  type GenerationError,
  type GenerationRef,
  type GenerationStatus,
  type JsonValue,
  type PendingOutput,
  type ProviderRef,
} from '@imaginator/core';
import type { PlacedFile } from '../assets/store.js';
import { nowIso } from '../db/index.js';
import { assets, generations, type GenerationRow } from '../db/schema.js';
import { notFound } from '../errors.js';
import { toGeneration, transact, type Emit, type ServiceContext } from './context.js';
import { Workbook } from './resolver.js';
import { loadCellHistory } from './view.js';

const ACTIVE = [...ACTIVE_STATUSES];

/**
 * Generation state transitions used by the runner and reconciler. Every
 * transition is guarded on the current status so a late writer (a completion
 * racing a confirmed cancel, a deleted row) becomes a no-op instead of a
 * corrupt row. Each returns whether the row changed.
 */
export function createGenerationService(ctx: ServiceContext) {
  function emitFor(emit: Emit, g: Pick<GenerationRow, 'id' | 'collection' | 'row' | 'column'>, status: GenerationStatus): void {
    emit({ type: 'generation.updated', id: g.id, collection: g.collection, row: g.row, column: g.column, status });
  }

  function transition(id: string, from: GenerationStatus[], set: Partial<typeof generations.$inferInsert>): boolean {
    return transact(ctx, (tx, emit) => {
      const g = tx.select().from(generations).where(eq(generations.id, id)).get();
      if (!g || !from.includes(g.status)) return false;
      tx.update(generations).set(set).where(eq(generations.id, id)).run();
      emitFor(emit, g, set.status ?? g.status);
      return true;
    });
  }

  return {
    getRow(id: string): GenerationRow | undefined {
      return ctx.db.select().from(generations).where(eq(generations.id, id)).get();
    },

    get(ref: GenerationRef): Generation {
      if ('id' in ref) {
        const g = this.getRow(ref.id);
        if (!g) throw notFound(`generation ${ref.id}`);
        return toGeneration(g);
      }
      const history = loadCellHistory(ctx.db, ref.collection, ref.row, ref.column);
      const g = ref.version === undefined ? history.find((h) => h.status !== 'cancelled') ?? history[0] : history.find((h) => h.version === ref.version);
      if (!g) throw notFound(`generation ${ref.collection}/${ref.row}/${ref.column}${ref.version === undefined ? '' : `#${ref.version}`}`);
      return toGeneration(g);
    },

    listByStatus(statuses: GenerationStatus[]): GenerationRow[] {
      return ctx.db.select().from(generations).where(inArray(generations.status, statuses)).orderBy(asc(generations.seq)).all();
    },

    /** Oldest queued generations first. */
    listQueued(limit = 200): GenerationRow[] {
      return ctx.db.select().from(generations).where(eq(generations.status, 'queued')).orderBy(asc(generations.seq)).limit(limit).all();
    },

    /**
     * Pick queued generations (oldest first) accepted by `pick` and mark them
     * `submitting` in the same transaction. Before claiming, each one is
     * revalidated against current state (DESIGN §4.2): its request must still
     * be desired, its scope live, and no hold may apply. Obsolete queued work
     * is cancelled instead of submitted. Returns the claimed rows.
     */
    claimQueued(pick: (g: GenerationRow) => boolean, limit = 200): GenerationRow[] {
      return transact(ctx, (tx, emit) => {
        const queued = tx.select().from(generations).where(eq(generations.status, 'queued')).orderBy(asc(generations.seq)).limit(limit).all();
        const claimed: GenerationRow[] = [];
        const now = nowIso();
        const wb = new Workbook(ctx, tx);
        const stillWanted = (g: GenerationRow): boolean => {
          const grid = wb.grid(g.collection);
          const row = grid?.rows.find((r) => r.id === g.row);
          if (!grid || !row || grid.status !== 'live' || row.paused) return false;
          const state = wb.state({ collection: g.collection, row: g.row, column: g.column });
          if (!state) return false;
          const { resolved, selection } = state;
          if (resolved.skipped || resolved.blocked || resolved.hash !== g.requestHash) return false;
          return !selection.held;
        };
        for (const g of queued) {
          if (!stillWanted(g)) {
            tx.update(generations).set({ status: 'cancelled', finishedAt: now }).where(eq(generations.id, g.id)).run();
            emitFor(emit, g, 'cancelled');
            continue;
          }
          if (!pick(g)) continue;
          tx.update(generations).set({ status: 'submitting', startedAt: g.startedAt ?? now }).where(eq(generations.id, g.id)).run();
          emitFor(emit, g, 'submitting');
          claimed.push({ ...g, status: 'submitting', startedAt: g.startedAt ?? now });
        }
        return claimed;
      });
    },

    /** Commit the provider handle and `running` atomically (from `submitting`, or `running` on a re-issued ref). */
    markRunning(id: string, ref: ProviderRef): boolean {
      return transition(id, ['submitting', 'running'], { status: 'running', providerRef: ref });
    },

    /** A retryable failure: back to `submitting` with the next attempt number. */
    markRetrying(id: string, attempt: number, error: GenerationError): boolean {
      return transition(id, ['submitting', 'running'], { status: 'submitting', attempt, providerRef: null, error });
    },

    /** Outputs are known (staged files or URLs): commit `downloading` before fetching anything remote. */
    markDownloading(id: string, pending: PendingOutput[], cost: number | undefined, providerMeta: JsonValue | undefined): boolean {
      return transition(id, ['submitting', 'running'], {
        status: 'downloading',
        pendingOutputs: pending,
        cost: cost ?? null,
        providerMeta: providerMeta ?? null,
      });
    },

    /** Insert asset rows, link outputs, and mark `succeeded` in one transaction. */
    markSucceeded(id: string, placed: PlacedFile[]): boolean {
      return transact(ctx, (tx, emit) => {
        const g = tx.select().from(generations).where(eq(generations.id, id)).get();
        if (!g || !ACTIVE.includes(g.status)) return false;
        const now = nowIso();
        for (const p of placed) {
          tx.insert(assets)
            .values({
              id: p.id,
              kind: p.kind,
              originType: 'generation',
              originGeneration: id,
              mime: p.mime,
              ext: p.ext,
              width: p.width,
              height: p.height,
              bytes: p.bytes,
              sha256: p.sha256,
              label: null,
              createdAt: now,
            })
            .run();
        }
        tx.update(generations)
          .set({ status: 'succeeded', outputs: placed.map((p) => p.id), pendingOutputs: null, error: null, finishedAt: now })
          .where(eq(generations.id, id))
          .run();
        for (const p of placed) emit({ type: 'asset.created', id: p.id });
        emitFor(emit, g, 'succeeded');
        return true;
      });
    },

    markFailed(id: string, error: GenerationError): boolean {
      return transition(id, ACTIVE, { status: 'failed', error, finishedAt: nowIso() });
    },

    markUnsupported(id: string, error: GenerationError): boolean {
      return transition(id, ACTIVE, { status: 'unsupported', error: { ...error, retryable: false }, finishedAt: nowIso() });
    },

    markNeedsAttention(id: string, message: string, code = 'needs_attention'): boolean {
      return transition(id, ACTIVE, { status: 'needs_attention', error: { message, code, retryable: false }, finishedAt: nowIso() });
    },

    /** Cancel an active generation (queued at once; submitted only after confirmed remote cancellation). */
    markCancelled(id: string, from: GenerationStatus[] = ACTIVE): boolean {
      return transition(id, from, { status: 'cancelled', finishedAt: nowIso() });
    },

    /** Cancel every queued generation in the given cells of a collection. */
    cancelQueuedInCells(collection: string, cells: Array<{ row: string; column: string }>): string[] {
      if (cells.length === 0) return [];
      return transact(ctx, (tx, emit) => {
        const out: string[] = [];
        for (const c of cells) {
          const list = tx
            .select()
            .from(generations)
            .where(and(eq(generations.collection, collection), eq(generations.row, c.row), eq(generations.column, c.column), eq(generations.status, 'queued')))
            .all();
          for (const g of list) {
            tx.update(generations).set({ status: 'cancelled', finishedAt: nowIso() }).where(eq(generations.id, g.id)).run();
            emitFor(emit, g, 'cancelled');
            out.push(g.id);
          }
        }
        return out;
      });
    },
  };
}

export type GenerationService = ReturnType<typeof createGenerationService>;
