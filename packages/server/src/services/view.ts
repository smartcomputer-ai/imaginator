import { and, asc, desc, eq } from 'drizzle-orm';
import {
  assetThumbUrl,
  assetUrl,
  formatCellAddress,
  isActiveStatus,
  type CellAddress,
  type CellAttempt,
  type CellView,
  type Collection,
  type CollectionSummary,
  type CollectionView,
  type Column,
  type Progress,
  type ResolveResult,
  type Row,
} from '@imaginator/core';
import { collections, generations, type GenerationRow } from '../db/schema.js';
import { requireCollection, type DbLike, type ServiceContext } from './context.js';
import { upstreamClosure } from './refs.js';
import { Workbook, cellKey, type Selection } from './resolver.js';

export { cellKey };

function attempt(g: GenerationRow): CellAttempt {
  return {
    generation: g.id,
    version: g.version,
    status: g.status,
    ...(g.error ? { error: g.error } : {}),
    timing: {
      queuedAt: g.queuedAt,
      ...(g.startedAt ? { startedAt: g.startedAt } : {}),
      ...(g.finishedAt ? { finishedAt: g.finishedAt } : {}),
    },
    ...(g.cost !== null && g.cost !== undefined ? { cost: g.cost } : {}),
  };
}

export interface CellState {
  view: CellView;
  resolved: ResolveResult;
  selection: Selection;
  live: boolean;
}

/** One cell's view plus the resolution it was built from. */
export function buildCellState(wb: Workbook, collection: Collection, row: Row, column: Column): CellState {
  const target: CellAddress = { collection: collection.slug, row: row.id, column: column.id };
  const { resolved, selection } = wb.state(target)!;
  const history = wb.cellGenerations(target);
  const live = history.filter((g) => g.status !== 'cancelled');
  const current = resolved.skipped ? undefined : selection.current;
  const latest = resolved.skipped ? undefined : selection.latest;
  const fallback = !current && !resolved.skipped ? wb.newestSuccess(target) : undefined;
  const shown = current ?? fallback;
  const status = resolved.skipped ? 'skipped' : latest ? latest.status : resolved.blocked ? 'blocked' : 'missing';
  const view: CellView = {
    row: row.id,
    column: column.id,
    address: formatCellAddress(target),
    hash: resolved.hash,
    status,
    ...(resolved.blocked && !resolved.skipped ? { blocked: resolved.blocked } : {}),
    ...(current ? { generation: current.id, version: current.version } : {}),
    ...(latest ? { latest: attempt(latest) } : {}),
    versions: live.length,
    outputs: shown?.outputs ?? [],
    urls: (shown?.outputs ?? []).map(assetUrl),
    thumbnails: (shown?.outputs ?? []).map(assetThumbUrl),
    ...(fallback ? { stale: true } : {}),
    ...(selection.held && !resolved.skipped ? { hold: true } : {}),
  };
  if (selection.pin) {
    const pinned = history.find((g) => g.id === selection.pin!.generation);
    if (pinned) view.pin = { generation: pinned.id, version: pinned.version, active: selection.pinActive };
  }
  const timingSource = latest ?? current;
  if (timingSource) {
    if (latest?.error) view.error = latest.error;
    const costSource = current ?? latest;
    if (costSource && costSource.cost !== null && costSource.cost !== undefined) view.cost = costSource.cost;
    view.timing = {
      queuedAt: timingSource.queuedAt,
      ...(timingSource.startedAt ? { startedAt: timingSource.startedAt } : {}),
      ...(timingSource.finishedAt ? { finishedAt: timingSource.finishedAt } : {}),
    };
  }
  // What the model ignores *now*, so the UI can say "seed ignored" even for an older snapshot.
  if (resolved.request.droppedKeys.length > 0) view.droppedKeys = resolved.request.droppedKeys;
  return { view, resolved, selection, live: collection.status === 'live' && !row.paused };
}

export function buildCellView(wb: Workbook, collection: Collection, row: Row, column: Column): CellView {
  return buildCellState(wb, collection, row, column).view;
}

/** Dependency-aware progress (DESIGN §5, "Collection progress and waiting"). */
export function buildProgress(ctx: ServiceContext, wb: Workbook, db: DbLike, collection: Collection, cells: CellState[]): Progress {
  const slug = collection.slug;
  const upstream = upstreamClosure(db, [slug]).filter((s) => s !== slug);
  let pendingReconcile = ctx.hooks.reconcilePending?.(slug) ?? false;
  let upQueued = 0;
  let upInFlight = 0;
  for (const s of upstream) {
    if (ctx.hooks.reconcilePending?.(s)) pendingReconcile = true;
    for (const list of wb.generations(s).values()) {
      for (const g of list) {
        if (g.status === 'queued') upQueued++;
        else if (isActiveStatus(g.status)) upInFlight++;
      }
    }
  }

  const blocked: Progress['blocked'] = [];
  const attention: Progress['attention'] = { failed: [], unsupported: [], needsAttention: [] };
  const failedAttempts: Progress['failedAttempts'] = [];
  let running = pendingReconcile || upQueued > 0 || upInFlight > 0;
  let allHaveCurrent = true;

  for (const c of cells) {
    const { view, resolved, selection, live } = c;
    if (resolved.skipped) continue;
    if (!selection.current) allHaveCurrent = false;
    if (resolved.blocked) {
      blocked.push({ cell: view.address, reason: resolved.blocked, pending: resolved.pending ?? false });
      if (resolved.pending) running = true;
      continue;
    }
    const latest = selection.latest;
    if (!latest) {
      // Nothing attempted yet: work is coming if the scope is live and not held.
      if (live && !selection.held) running = true;
      continue;
    }
    if (isActiveStatus(latest.status)) {
      running = true;
      continue;
    }
    const issue = { cell: view.address, message: latest.error?.message ?? latest.status };
    if (latest.status === 'succeeded') continue;
    if (selection.current) {
      failedAttempts.push(issue);
    } else if (latest.status === 'failed') attention.failed.push(issue);
    else if (latest.status === 'unsupported') attention.unsupported.push(issue);
    else if (latest.status === 'needs_attention') attention.needsAttention.push(issue);
  }

  const state: Progress['state'] = running ? 'running' : blocked.length > 0 ? 'blocked' : 'settled';
  return {
    state,
    allSucceeded: state === 'settled' && allHaveCurrent && attention.failed.length === 0 && attention.unsupported.length === 0 && attention.needsAttention.length === 0,
    pendingReconcile,
    upstream: { queued: upQueued, inFlight: upInFlight },
    blocked,
    attention,
    failedAttempts,
  };
}

export function buildCollectionView(ctx: ServiceContext, db: DbLike, slug: string): CollectionView {
  const collection = requireCollection(db, slug);
  const wb = new Workbook(ctx, db);
  const states: CellState[] = [];
  for (const row of collection.rows) {
    for (const column of collection.columns) {
      states.push(buildCellState(wb, collection, row, column));
    }
  }
  let inFlight = 0;
  let queued = 0;
  for (const list of wb.generations(slug).values()) {
    for (const g of list) {
      if (g.status === 'queued') queued++;
      else if (isActiveStatus(g.status)) inFlight++;
    }
  }
  const progress = buildProgress(ctx, wb, db, collection, states);
  return { ...collection, cells: states.map((s) => s.view), cursor: ctx.bus.cursor(slug), inFlight, queued, progress };
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
      progress: view.progress.state,
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
