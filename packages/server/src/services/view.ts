import { and, asc, desc, eq } from 'drizzle-orm';
import {
  assetThumbUrl,
  assetUrl,
  formatCellAddress,
  isActiveStatus,
  resolveCell,
  type Asset,
  type CellView,
  type Collection,
  type CollectionSummary,
  type CollectionView,
  type Column,
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

export function buildCellView(
  ctx: ServiceContext,
  collection: Collection,
  row: Row,
  column: Column,
  gens: CellGen[],
  assetOf: (id: string) => Asset | undefined,
): CellView {
  const resolved = resolveCell(collection, row, column, { registry: ctx.registry, asset: assetOf });
  const live = gens.filter((g) => g.status !== 'cancelled');
  const current = live.find((g) => g.requestHash === resolved.hash);
  const view: CellView = {
    row: row.id,
    column: column.id,
    address: formatCellAddress({ collection: collection.slug, row: row.id, column: column.id }),
    hash: resolved.hash,
    status: current ? current.status : 'missing',
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
  const assetOf = assetLookupFor(db, collection);
  const cells: CellView[] = [];
  for (const row of collection.rows) {
    for (const column of collection.columns) {
      cells.push(buildCellView(ctx, collection, row, column, gens.get(cellKey(row.id, column.id)) ?? [], assetOf));
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
