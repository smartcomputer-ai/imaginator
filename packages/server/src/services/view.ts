import { and, asc, desc, eq } from 'drizzle-orm';
import {
  assetThumbUrl,
  assetUrl,
  createGridResolver,
  formatCellAddress,
  isActiveStatus,
  type Asset,
  type CellView,
  type Collection,
  type CollectionSummary,
  type CollectionView,
  type Column,
  type ResolveResult,
  type Row,
} from '@imaginator/core';
import { collections, generations, type GenerationRow } from '../db/schema.js';
import { assetLookupFor, requireCollection, type DbLike, type ServiceContext } from './context.js';

const CELL_COLUMNS = {
  id: generations.id,
  row: generations.row,
  column: generations.column,
  version: generations.version,
  requestHash: generations.requestHash,
  status: generations.status,
  outputs: generations.outputs,
  error: generations.error,
  request: generations.request,
  queuedAt: generations.queuedAt,
  startedAt: generations.startedAt,
  finishedAt: generations.finishedAt,
  cost: generations.cost,
} as const;

export type CellGen = Pick<GenerationRow, keyof typeof CELL_COLUMNS>;

export function cellKey(row: string, column: string): string {
  return `${row} ${column}`;
}

/** Newest non-cancelled generation of a cell with exactly this hash; the cell's current version. */
export function currentOf<G extends { status: string; requestHash: string; version: number }>(gens: G[] | undefined, hash: string): G | undefined {
  let best: G | undefined;
  for (const g of gens ?? []) {
    if (g.status === 'cancelled' || g.requestHash !== hash) continue;
    if (!best || g.version > best.version) best = g;
  }
  return best;
}

export type GridResolver = (row: string, column: string) => ResolveResult;

/**
 * Resolver for every cell of a collection. Row references read the upstream
 * cell's current generation from `gens` (any order, any status).
 */
export function gridResolverFor(
  ctx: ServiceContext,
  collection: Collection,
  gens: Map<string, Pick<GenerationRow, 'status' | 'requestHash' | 'version' | 'outputs'>[]>,
  assetOf: (id: string) => Asset | undefined,
): GridResolver {
  return createGridResolver(collection, {
    registry: ctx.registry,
    asset: assetOf,
    generation: (row, column, hash) => {
      const g = currentOf(gens.get(cellKey(row, column)), hash);
      return g ? { status: g.status, outputs: g.outputs } : undefined;
    },
  });
}

/** Newest-first generations grouped by cell. */
export function loadCellGenerations(db: DbLike, slug: string): Map<string, CellGen[]> {
  const list = db.select(CELL_COLUMNS).from(generations).where(eq(generations.collection, slug)).orderBy(desc(generations.version)).all();
  const map = new Map<string, CellGen[]>();
  for (const g of list) {
    const k = cellKey(g.row, g.column);
    let arr = map.get(k);
    if (!arr) map.set(k, (arr = []));
    arr.push(g);
  }
  return map;
}

export function buildCellView(collection: Collection, row: Row, column: Column, gens: CellGen[], resolve: GridResolver): CellView {
  const resolved = resolve(row.id, column.id);
  const live = gens.filter((g) => g.status !== 'cancelled');
  const current = resolved.blocked ? undefined : currentOf(live, resolved.hash);
  const view: CellView = {
    row: row.id,
    column: column.id,
    address: formatCellAddress({ collection: collection.slug, row: row.id, column: column.id }),
    hash: resolved.hash,
    status: current ? current.status : resolved.blocked ? 'blocked' : 'missing',
    ...(resolved.blocked ? { blocked: resolved.blocked } : {}),
    versions: live.length,
    outputs: current?.outputs ?? [],
    urls: (current?.outputs ?? []).map(assetUrl),
    thumbnails: (current?.outputs ?? []).map(assetThumbUrl),
  };
  if (current) {
    view.generation = current.id;
    view.version = current.version;
    if (current.error) view.error = current.error;
    if (current.cost !== null && current.cost !== undefined) view.cost = current.cost;
    view.timing = {
      queuedAt: current.queuedAt,
      ...(current.startedAt ? { startedAt: current.startedAt } : {}),
      ...(current.finishedAt ? { finishedAt: current.finishedAt } : {}),
    };
  }
  // What the model ignores *now*, so the UI can say "seed ignored" even for an older snapshot.
  if (resolved.request.droppedKeys.length > 0) view.droppedKeys = resolved.request.droppedKeys;
  return view;
}

export function buildCollectionView(ctx: ServiceContext, db: DbLike, slug: string): CollectionView {
  const collection = requireCollection(db, slug);
  const gens = loadCellGenerations(db, slug);
  const resolve = gridResolverFor(ctx, collection, gens, assetLookupFor(db, collection));
  const cells: CellView[] = [];
  for (const row of collection.rows) {
    for (const column of collection.columns) {
      cells.push(buildCellView(collection, row, column, gens.get(cellKey(row.id, column.id)) ?? [], resolve));
    }
  }
  let inFlight = 0;
  let queued = 0;
  for (const list of gens.values()) {
    for (const g of list) {
      if (g.status === 'queued') queued++;
      else if (isActiveStatus(g.status)) inFlight++;
    }
  }
  return { ...collection, cells, cursor: ctx.bus.cursor(slug), inFlight, queued };
}

export function buildSummaries(ctx: ServiceContext, db: DbLike): CollectionSummary[] {
  const slugs = db.select({ slug: collections.slug }).from(collections).orderBy(asc(collections.createdAt), asc(collections.slug)).all();
  return slugs.map(({ slug }) => {
    const view = buildCollectionView(ctx, db, slug);
    let succeeded = 0;
    let failed = 0;
    for (const c of view.cells) {
      if (c.status === 'succeeded') succeeded++;
      else if (c.status === 'failed' || c.status === 'unsupported' || c.status === 'needs_attention') failed++;
    }
    return {
      slug: view.slug,
      title: view.title,
      ...(view.description !== undefined ? { description: view.description } : {}),
      status: view.status,
      rows: view.rows.length,
      columns: view.columns.length,
      cells: view.cells.length,
      succeeded,
      inFlight: view.inFlight,
      queued: view.queued,
      failed,
      cursor: view.cursor,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    };
  });
}

/** Every generation of a cell, newest version first. */
export function loadCellHistory(db: DbLike, slug: string, row: string, column: string): GenerationRow[] {
  return db
    .select()
    .from(generations)
    .where(and(eq(generations.collection, slug), eq(generations.row, row), eq(generations.column, column)))
    .orderBy(desc(generations.version))
    .all();
}
