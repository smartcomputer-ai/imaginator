import { eq } from 'drizzle-orm';
import {
  cellKeyOf,
  createWorkbookResolver,
  type Asset,
  type CellAddress,
  type Collection,
  type ResolveResult,
  type WorkbookResolver,
} from '@imaginator/core';
import { assets, cellHolds, cellPins, generations, type CellHoldRow, type CellPinRow, type GenerationRow } from '../db/schema.js';
import { loadCollection, toAsset, type DbLike, type ServiceContext } from './context.js';

export function cellKey(row: string, column: string): string {
  return `${row} ${column}`;
}

/** Which generation of a cell is current, and which attempt is latest, for one desired hash. */
export interface Selection {
  /** Current success: the active pin, else the newest succeeded generation with the hash. */
  current?: GenerationRow;
  /** Newest non-cancelled generation with the hash, any status. */
  latest?: GenerationRow;
  pin?: CellPinRow;
  /** The pin names a succeeded generation with the desired hash. */
  pinActive: boolean;
  hold?: CellHoldRow;
  /** The hold is for the desired hash. */
  held: boolean;
}

/**
 * Lazily loaded view of every collection a pass touches, plus the resolver
 * over it. One instance per transaction or per read; nothing is cached across.
 */
export class Workbook {
  private readonly grids = new Map<string, Collection | undefined>();
  private readonly gens = new Map<string, Map<string, GenerationRow[]>>();
  private readonly pins = new Map<string, Map<string, CellPinRow>>();
  private readonly holds = new Map<string, Map<string, CellHoldRow>>();
  private readonly assetCache = new Map<string, Asset | undefined>();
  readonly resolver: WorkbookResolver;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly db: DbLike,
  ) {
    this.resolver = createWorkbookResolver({
      registry: ctx.registry,
      asset: (id) => this.asset(id),
      grid: (slug) => this.grid(slug),
      cell: (target, hash) => {
        const sel = this.selection(target, hash);
        return {
          ...(sel.current ? { outputs: sel.current.outputs } : {}),
          ...(sel.latest ? { latestStatus: sel.latest.status } : {}),
          ...(sel.latest?.error?.message ? { latestError: sel.latest.error.message } : {}),
          ...(sel.held ? { held: true } : {}),
        };
      },
    });
  }

  grid(slug: string): Collection | undefined {
    if (!this.grids.has(slug)) this.grids.set(slug, loadCollection(this.db, slug));
    return this.grids.get(slug);
  }

  asset(id: string): Asset | undefined {
    if (!this.assetCache.has(id)) {
      const a = this.db.select().from(assets).where(eq(assets.id, id)).get();
      this.assetCache.set(id, a ? toAsset(a) : undefined);
    }
    return this.assetCache.get(id);
  }

  /** Every generation of a collection grouped by cell, newest version first. Cancelled ones included. */
  generations(slug: string): Map<string, GenerationRow[]> {
    let map = this.gens.get(slug);
    if (!map) {
      map = new Map();
      const list = this.db.select().from(generations).where(eq(generations.collection, slug)).all();
      list.sort((a, b) => b.version - a.version);
      for (const g of list) {
        const k = cellKey(g.row, g.column);
        let arr = map.get(k);
        if (!arr) map.set(k, (arr = []));
        arr.push(g);
      }
      this.gens.set(slug, map);
    }
    return map;
  }

  cellGenerations(target: CellAddress): GenerationRow[] {
    return this.generations(target.collection).get(cellKey(target.row, target.column)) ?? [];
  }

  pin(target: CellAddress): CellPinRow | undefined {
    let map = this.pins.get(target.collection);
    if (!map) {
      map = new Map(this.db.select().from(cellPins).where(eq(cellPins.collection, target.collection)).all().map((p) => [cellKey(p.row, p.column), p]));
      this.pins.set(target.collection, map);
    }
    return map.get(cellKey(target.row, target.column));
  }

  hold(target: CellAddress): CellHoldRow | undefined {
    let map = this.holds.get(target.collection);
    if (!map) {
      map = new Map(this.db.select().from(cellHolds).where(eq(cellHolds.collection, target.collection)).all().map((h) => [cellKey(h.row, h.column), h]));
      this.holds.set(target.collection, map);
    }
    return map.get(cellKey(target.row, target.column));
  }

  /** Current success, latest attempt, pin and hold of a cell for exactly `hash`. */
  selection(target: CellAddress, hash: string): Selection {
    const gens = this.cellGenerations(target);
    const pin = this.pin(target);
    const hold = this.hold(target);
    let latest: GenerationRow | undefined;
    let newestSuccess: GenerationRow | undefined;
    let pinned: GenerationRow | undefined;
    for (const g of gens) {
      if (g.status === 'cancelled' || g.requestHash !== hash) continue;
      if (!latest || g.version > latest.version) latest = g;
      if (g.status === 'succeeded') {
        if (!newestSuccess || g.version > newestSuccess.version) newestSuccess = g;
        if (pin && pin.generation === g.id) pinned = g;
      }
    }
    return {
      ...(pinned ?? newestSuccess ? { current: pinned ?? newestSuccess } : {}),
      ...(latest ? { latest } : {}),
      ...(pin ? { pin } : {}),
      pinActive: pinned !== undefined,
      ...(hold ? { hold } : {}),
      held: hold !== undefined && hold.requestHash === hash,
    };
  }

  resolve(target: CellAddress): ResolveResult | undefined {
    return this.resolver.resolve(target);
  }

  /** Resolve plus selection in one call; `undefined` when the cell does not exist. */
  state(target: CellAddress): { resolved: ResolveResult; selection: Selection } | undefined {
    const resolved = this.resolve(target);
    if (!resolved) return undefined;
    return { resolved, selection: this.selection(target, resolved.hash) };
  }

  /** The newest successful generation in a cell's whole history (display fallback). */
  newestSuccess(target: CellAddress): GenerationRow | undefined {
    let best: GenerationRow | undefined;
    for (const g of this.cellGenerations(target)) {
      if (g.status === 'succeeded' && (!best || g.version > best.version)) best = g;
    }
    return best;
  }

  static key(target: CellAddress): string {
    return cellKeyOf(target);
  }
}
