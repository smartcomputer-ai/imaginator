import { and, eq } from 'drizzle-orm';
import { formatCellAddress, isActiveStatus, type CellAddress, type CellView, type Generation, type GenerationSummary } from '@imaginator/core';
import type { Tx } from '../db/index.js';
import { cellHolds, cellPins, type GenerationRow } from '../db/schema.js';
import { conflict, notFound } from '../errors.js';
import { insertGeneration, requireCollection, toGeneration, transact, type Emit, type ServiceContext } from './context.js';
import type { GenerationService } from './generations.js';
import { addressList, directDependents, transitiveDependents } from './refs.js';
import { Workbook, type Selection } from './resolver.js';
import { buildCellState } from './view.js';

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

const cellCond = (addr: CellAddress, t: typeof cellPins | typeof cellHolds) => and(eq(t.collection, addr.collection), eq(t.row, addr.row), eq(t.column, addr.column));

export function setPinTx(tx: Tx, emit: Emit, addr: CellAddress, generation: string): void {
  tx.delete(cellPins).where(cellCond(addr, cellPins)).run();
  tx.insert(cellPins).values({ collection: addr.collection, row: addr.row, column: addr.column, generation }).run();
  emit({ type: 'cell.updated', collection: addr.collection, row: addr.row, column: addr.column });
}

export function clearHoldTx(tx: Tx, emit: Emit, addr: CellAddress): boolean {
  const existing = tx.select().from(cellHolds).where(cellCond(addr, cellHolds)).get();
  if (!existing) return false;
  tx.delete(cellHolds).where(cellCond(addr, cellHolds)).run();
  emit({ type: 'cell.updated', collection: addr.collection, row: addr.row, column: addr.column });
  return true;
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

  /** Resolve inside a transaction and refuse the things no imperative may do to a cell. */
  function locateTx(tx: Tx, addr: CellAddress) {
    const wb = new Workbook(ctx, tx);
    const collection = wb.grid(addr.collection);
    if (!collection) throw notFound(`collection ${addr.collection}`);
    const row = collection.rows.find((r) => r.id === addr.row);
    const column = collection.columns.find((c) => c.id === addr.column);
    if (!row) throw notFound(`row ${addr.collection}/${addr.row}`);
    if (!column) throw notFound(`column ${addr.collection}/${addr.column}`);
    const { resolved, selection } = wb.state(addr)!;
    return { wb, collection, row, column, resolved, selection };
  }

  function requireRunnable(s: ReturnType<typeof locateTx>, addr: CellAddress): void {
    if (s.collection.status === 'paused') throw conflict(`collection ${addr.collection} is paused`);
    if (s.row.paused) throw conflict(`row ${addr.collection}/${addr.row} is paused`);
    if (s.resolved.skipped) throw conflict(`cell ${formatCellAddress(addr)} is skipped: row ${addr.row} does not run in column ${addr.column}`);
    if (s.resolved.blocked) throw conflict(`cell is blocked: ${s.resolved.blocked}`);
  }

  function view(addr: CellAddress): CellView {
    const { collection, row, column } = locate(addr);
    return buildCellState(new Workbook(ctx, ctx.db), collection, row, column).view;
  }

  function insert(tx: Tx, emit: Emit, addr: CellAddress, s: ReturnType<typeof locateTx>, forced: boolean): GenerationRow {
    return insertGeneration(tx, emit, {
      collection: addr.collection,
      row: addr.row,
      column: addr.column,
      requestHash: s.resolved.hash,
      request: s.resolved.request,
      unsupported: s.resolved.unsupported,
      forced,
    });
  }

  return {
    get(addr: CellAddress): {
      cell: CellView;
      current?: Generation;
      latest?: Generation;
      versions: GenerationSummary[];
      precedents: string[];
      dependents: string[];
      cursor: string;
    } {
      const { collection, row, column } = locate(addr);
      const wb = new Workbook(ctx, ctx.db);
      const state = buildCellState(wb, collection, row, column);
      const history = wb.cellGenerations(addr);
      const current = state.selection.current;
      const latest = state.selection.latest;
      return {
        cell: state.view,
        ...(current ? { current: toGeneration(current) } : {}),
        ...(latest && latest.id !== current?.id ? { latest: toGeneration(latest) } : {}),
        versions: history.filter((g) => g.status !== 'cancelled').map(summary),
        precedents: addressList(state.resolved.precedents),
        dependents: addressList(directDependents(ctx.db, addr)),
        cursor: ctx.bus.cursor(addr.collection),
      };
    },

    /** "Give me another one": a new generation with the same hash, forced. `holdCurrent` pins the current success first. */
    regenerate(addr: CellAddress, opts: { holdCurrent?: boolean } = {}): { generation: Generation; cursor: string } {
      const inserted = transact(ctx, (tx, emit) => {
        const s = locateTx(tx, addr);
        requireRunnable(s, addr);
        if (s.selection.latest?.status === 'unsupported') throw conflict(`cell is unsupported: ${s.selection.latest.error?.message ?? ''}`);
        if (opts.holdCurrent) {
          if (!s.selection.current) throw conflict('holdCurrent needs a current successful generation to pin');
          if (!s.selection.pinActive) setPinTx(tx, emit, addr, s.selection.current.id);
        }
        clearHoldTx(tx, emit, addr);
        return insert(tx, emit, addr, s, true);
      });
      return { generation: toGeneration(inserted), cursor: ctx.bus.cursor(addr.collection) };
    },

    /** Retry the latest failed / unsupported / needs_attention attempt, or release an explicit cancellation hold. */
    retry(addr: CellAddress): { generation: Generation; cursor: string } {
      const inserted = transact(ctx, (tx, emit) => {
        const s = locateTx(tx, addr);
        requireRunnable(s, addr);
        const latest = s.selection.latest;
        const released = clearHoldTx(tx, emit, addr);
        if (latest && isActiveStatus(latest.status)) throw conflict(`cell is ${latest.status}; wait for it or cancel it first`);
        if (latest && latest.status === 'succeeded' && !released) {
          throw conflict('cell succeeded; use regenerate for another sample');
        }
        if (!latest && !released) throw conflict('nothing to retry: the cell has no attempt yet');
        return insert(tx, emit, addr, s, false);
      });
      return { generation: toGeneration(inserted), cursor: ctx.bus.cursor(addr.collection) };
    },

    /**
     * Cancel the in-flight generation of a cell and hold its desired hash so
     * the next pass does not recreate it (DESIGN §4.1). Queued work is
     * cancelled at once; submitted work only when the provider confirms.
     */
    async cancel(addr: CellAddress): Promise<{ generation?: Generation; cursor: string }> {
      const { active, hash } = transact(ctx, (tx, emit) => {
        const s = locateTx(tx, addr);
        const active = s.wb.cellGenerations(addr).find((g) => isActiveStatus(g.status));
        const hash = !s.resolved.skipped && !s.resolved.blocked ? s.resolved.hash : undefined;
        if (hash !== undefined) {
          tx.delete(cellHolds).where(cellCond(addr, cellHolds)).run();
          tx.insert(cellHolds).values({ collection: addr.collection, row: addr.row, column: addr.column, requestHash: hash }).run();
          emit({ type: 'cell.updated', collection: addr.collection, row: addr.row, column: addr.column });
        }
        return { active, hash };
      });
      void hash;
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

    /** Pin a successful generation with the desired hash as current (default: the current success). */
    pin(addr: CellAddress, pick: { version?: number; generation?: string } = {}): { cell: CellView; cursor: string } {
      transact(ctx, (tx, emit) => {
        const s = locateTx(tx, addr);
        if (s.resolved.skipped) throw conflict(`cell ${formatCellAddress(addr)} is skipped`);
        if (s.resolved.blocked) throw conflict(`cell is blocked: ${s.resolved.blocked}`);
        const history = s.wb.cellGenerations(addr);
        let target: GenerationRow | undefined;
        if (pick.generation !== undefined) target = history.find((g) => g.id === pick.generation);
        else if (pick.version !== undefined) target = history.find((g) => g.version === pick.version);
        else target = s.selection.current;
        if (!target) throw notFound(`generation to pin in ${formatCellAddress(addr)}`);
        if (target.status !== 'succeeded') throw conflict(`only a succeeded generation can be pinned (v${target.version} is ${target.status})`);
        if (target.requestHash !== s.resolved.hash) throw conflict(`v${target.version} no longer matches the cell's content; only a matching success can be pinned`);
        setPinTx(tx, emit, addr, target.id);
      });
      return { cell: view(addr), cursor: ctx.bus.cursor(addr.collection) };
    },

    unpin(addr: CellAddress): { cell: CellView; cursor: string } {
      transact(ctx, (tx, emit) => {
        locateTx(tx, addr);
        const existing = tx.select().from(cellPins).where(cellCond(addr, cellPins)).get();
        if (!existing) return;
        tx.delete(cellPins).where(cellCond(addr, cellPins)).run();
        emit({ type: 'cell.updated', collection: addr.collection, row: addr.row, column: addr.column });
      });
      return { cell: view(addr), cursor: ctx.bus.cursor(addr.collection) };
    },

    /** Read-only cascade preview (DESIGN §4.1, "Cascade visibility"). */
    impact(addr: CellAddress, action: 'regenerate' | 'retry' | 'pin' | 'unpin' = 'regenerate') {
      locate(addr);
      const wb = new Workbook(ctx, ctx.db);
      const source = wb.state(addr)!;
      const direct = directDependents(ctx.db, addr);
      const all = transitiveDependents(ctx.db, addr);
      const collections = [...new Set(all.map((c) => c.collection))];
      const pausedCollections = new Set<string>();
      const pausedRows = new Set<string>();
      const pinned: string[] = [];
      for (const c of all) {
        const g = wb.grid(c.collection);
        if (!g) continue;
        if (g.status === 'paused') pausedCollections.add(c.collection);
        const row = g.rows.find((r) => r.id === c.row);
        if (row?.paused) pausedRows.add(`${c.collection}/${c.row}`);
        const st = wb.state(c);
        if (st?.selection.pinActive) pinned.push(formatCellAddress(c));
      }
      const cursors: Record<string, string> = { [addr.collection]: ctx.bus.cursor(addr.collection) };
      for (const s of collections) cursors[s] = ctx.bus.cursor(s);
      return {
        cell: formatCellAddress(addr),
        action,
        cells: addressList(all),
        collections,
        direct: direct.length,
        transitive: all.length,
        sourcePinned: source.selection.pinActive,
        paused: { collections: [...pausedCollections], rows: [...pausedRows] },
        pinned,
        cursors,
      };
    },
  };
}

export type CellService = ReturnType<typeof createCellService>;
export type { Selection };
