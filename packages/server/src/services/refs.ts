import { and, eq, isNull, or } from 'drizzle-orm';
import { cellKeyOf, cellPrecedents, formatCellAddress, isRef, type CellAddress, type Collection } from '@imaginator/core';
import type { Tx } from '../db/index.js';
import { refs } from '../db/schema.js';
import { conflict, invalid } from '../errors.js';
import { loadCollection, type DbLike } from './context.js';

/**
 * The reference index (DESIGN §3, References): every live input as written,
 * keyed by the row or column that carries it. Rebuilt for a collection inside
 * the transaction that changes its rows or columns.
 */
export function rewriteRefs(tx: Tx, slug: string): void {
  tx.delete(refs).where(eq(refs.fromCollection, slug)).run();
  const c = loadCollection(tx, slug);
  if (!c) return;
  const values: (typeof refs.$inferInsert)[] = [];
  for (const row of c.rows) {
    for (const input of row.inputs) {
      if (!isRef(input)) continue;
      values.push({ fromCollection: slug, fromKind: 'row', fromId: row.id, toCollection: input.collection ?? slug, toRow: input.row ?? null, toColumn: input.column ?? null });
    }
  }
  for (const column of c.columns) {
    for (const input of column.inputs ?? []) {
      if (!isRef(input)) continue;
      values.push({ fromCollection: slug, fromKind: 'column', fromId: column.id, toCollection: input.collection ?? slug, toRow: input.row ?? null, toColumn: input.column ?? null });
    }
  }
  if (values.length > 0) tx.insert(refs).values(values).run();
}

/** Collections whose rows or columns reference `slug` (excluding itself). */
export function dependentCollections(db: DbLike, slug: string): string[] {
  const list = db.selectDistinct({ from: refs.fromCollection }).from(refs).where(eq(refs.toCollection, slug)).all();
  return list.map((r) => r.from).filter((s) => s !== slug);
}

/** Collections that `slug` references (excluding itself). */
export function referencedCollections(db: DbLike, slug: string): string[] {
  const list = db.selectDistinct({ to: refs.toCollection }).from(refs).where(eq(refs.fromCollection, slug)).all();
  return list.map((r) => r.to).filter((s) => s !== slug);
}

/** Transitive closure over `next`, starting from `start` (included). */
function closure(start: Iterable<string>, next: (slug: string) => string[]): string[] {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (seen.has(s)) continue;
    seen.add(s);
    for (const n of next(s)) if (!seen.has(n)) stack.push(n);
  }
  return [...seen];
}

/** `slugs` plus every collection that transitively depends on them. */
export function dependentClosure(db: DbLike, slugs: Iterable<string>): string[] {
  return closure(slugs, (s) => dependentCollections(db, s));
}

/** `slugs` plus every collection they transitively reference. */
export function upstreamClosure(db: DbLike, slugs: Iterable<string>): string[] {
  return closure(slugs, (s) => referencedCollections(db, s));
}

/** Every collection reachable from `slug` in either direction: where a cycle could pass. */
export function connectedCollections(db: DbLike, slug: string): string[] {
  return closure([slug], (s) => [...dependentCollections(db, s), ...referencedCollections(db, s)]);
}

/**
 * Written references that point at the given row, column, or collection,
 * excluding those written inside `except` collections.
 *
 * A relative anchor (`toRow`/`toColumn` null) means "the same row/column as
 * the referrer". With `includeRelative` those match any row/column: the
 * right reading when expanding dependents of a concrete cell. Without it,
 * only explicit anchors match: the right reading for removal guards, since
 * removing a column takes a same-column referrer out with its source and
 * nothing is left dangling.
 */
export function referencesTo(
  db: DbLike,
  target: { collection: string; row?: string; column?: string },
  except: { collections?: string[]; rows?: string[]; columns?: string[] } = {},
  opts: { includeRelative?: boolean } = {},
): Array<{ from: string; kind: 'row' | 'column'; id: string }> {
  const conds = [eq(refs.toCollection, target.collection)];
  const match = (col: typeof refs.toRow | typeof refs.toColumn, value: string) => (opts.includeRelative ? or(isNull(col), eq(col, value))! : eq(col, value));
  if (target.row !== undefined) conds.push(match(refs.toRow, target.row));
  if (target.column !== undefined) conds.push(match(refs.toColumn, target.column));
  const list = db.select().from(refs).where(and(...conds)).all();
  return list
    .filter((r) => {
      if (except.collections?.includes(r.fromCollection)) return false;
      if (r.fromCollection === target.collection) {
        if (r.fromKind === 'row' && except.rows?.includes(r.fromId)) return false;
        if (r.fromKind === 'column' && except.columns?.includes(r.fromId)) return false;
      }
      return true;
    })
    .map((r) => ({ from: r.fromCollection, kind: r.fromKind, id: r.fromId }));
}

export function describeReferrers(list: Array<{ from: string; kind: 'row' | 'column'; id: string }>): string {
  return list.map((r) => `${r.from}/${r.id}`).join(', ');
}

// ---------------------------------------------------------------------------
// Concrete cell graph
// ---------------------------------------------------------------------------

/** Concrete precedent edges for every cell of the given collections (targets that exist only). */
export function cellGraph(grids: Map<string, Collection>): Map<string, CellAddress[]> {
  const edges = new Map<string, CellAddress[]>();
  const exists = (t: CellAddress) => {
    const g = grids.get(t.collection);
    return !!g && g.rows.some((r) => r.id === t.row) && g.columns.some((c) => c.id === t.column);
  };
  for (const g of grids.values()) {
    for (const row of g.rows) {
      for (const column of g.columns) {
        const from = { collection: g.slug, row: row.id, column: column.id };
        edges.set(cellKeyOf(from), cellPrecedents(g.slug, row, column).filter(exists));
      }
    }
  }
  return edges;
}

function loadGrids(db: DbLike, slugs: Iterable<string>): Map<string, Collection> {
  const grids = new Map<string, Collection>();
  for (const s of slugs) {
    const g = loadCollection(db, s);
    if (g) grids.set(s, g);
  }
  return grids;
}

/**
 * Refuse a reference cycle anywhere in the component that contains `slug`.
 * Runs on the concrete cell graph, all cells included (a cycle through a
 * currently skipped or unresolved cell is refused too, since a later edit
 * could activate it). Grids are small; a plain DFS is exact.
 */
export function assertNoCycles(db: DbLike, slug: string): void {
  const grids = loadGrids(db, connectedCollections(db, slug));
  const edges = cellGraph(grids);
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (key: string): void => {
    const s = state.get(key);
    if (s === 2) return;
    if (s === 1) {
      const cycle = path.slice(path.indexOf(key)).concat(key);
      throw invalid(`reference cycle: ${cycle.join(' → ')}`);
    }
    state.set(key, 1);
    path.push(key);
    for (const t of edges.get(key) ?? []) visit(cellKeyOf(t));
    path.pop();
    state.set(key, 2);
  };
  for (const key of edges.keys()) visit(key);
}

/** Cells whose concrete precedents include `target` (direct dependents). */
export function directDependents(db: DbLike, target: CellAddress, grids?: Map<string, Collection>): CellAddress[] {
  const referrers = referencesTo(db, target, {}, { includeRelative: true });
  const out: CellAddress[] = [];
  const seen = new Set<string>();
  const cache = grids ?? new Map<string, Collection>();
  const gridOf = (s: string) => {
    if (!cache.has(s)) {
      const g = loadCollection(db, s);
      if (g) cache.set(s, g);
    }
    return cache.get(s);
  };
  const tk = cellKeyOf(target);
  for (const r of referrers) {
    const g = gridOf(r.from);
    if (!g) continue;
    const cells: Array<{ row: Collection['rows'][number]; column: Collection['columns'][number] }> = [];
    if (r.kind === 'row') {
      const row = g.rows.find((x) => x.id === r.id);
      if (row) for (const column of g.columns) cells.push({ row, column });
    } else {
      const column = g.columns.find((x) => x.id === r.id);
      if (column) for (const row of g.rows) cells.push({ row, column });
    }
    for (const { row, column } of cells) {
      if (!cellPrecedents(g.slug, row, column).some((p) => cellKeyOf(p) === tk)) continue;
      const from = { collection: g.slug, row: row.id, column: column.id };
      const k = cellKeyOf(from);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(from);
      }
    }
  }
  return out;
}

/** Transitive dependents of `target`, breadth first, excluding the target itself. */
export function transitiveDependents(db: DbLike, target: CellAddress): CellAddress[] {
  const grids = new Map<string, Collection>();
  const seen = new Set<string>([cellKeyOf(target)]);
  const out: CellAddress[] = [];
  const queue = [target];
  while (queue.length > 0) {
    const t = queue.shift()!;
    for (const d of directDependents(db, t, grids)) {
      const k = cellKeyOf(d);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(d);
      queue.push(d);
    }
  }
  return out;
}

export function addressList(cells: CellAddress[]): string[] {
  return cells.map((c) => formatCellAddress(c));
}

/** Guard used by delete flows: throw if anything outside the removal set references the target. */
export function assertUnreferenced(
  db: DbLike,
  target: { collection: string; row?: string; column?: string },
  except: { collections?: string[]; rows?: string[]; columns?: string[] },
  what: string,
): void {
  const list = referencesTo(db, target, except);
  if (list.length > 0) throw conflict(`${what} is referenced by ${describeReferrers(list)}; change or remove those first`);
}
