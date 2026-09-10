import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  assetThumbUrl,
  assetUrl,
  isRowRef,
  randomId,
  type Asset,
  type AssetView,
  type Collection,
  type Column,
  type Generation,
  type ModelRegistry,
  type ResolvedRequest,
  type Row,
} from '@imaginator/core';
import type { AssetStore } from '../assets/store.js';
import type { ServerConfig } from '../config.js';
import { nowIso, type Db, type Tx } from '../db/index.js';
import { assets, collections, columns, generations, rows, type AssetRow, type ColumnRow, type GenerationRow, type RowRow } from '../db/schema.js';
import type { EventBus, EventInput } from '../events/bus.js';
import { notFound } from '../errors.js';

/** Hooks the engine registers so services can reach it without a dependency cycle. */
export interface EngineHooks {
  /** Abort local execution of generations (deleted, or cancellation confirmed). */
  abortGenerations?: (ids: string[], reason: string) => void;
  /** Resolve once no reconcile pass is pending or running for the collection. */
  reconcileSettled?: (collection: string) => Promise<void>;
  /** Run a reconcile pass right away (resume/unpause). */
  reconcileNow?: (collection: string) => Promise<void>;
}

export interface ServiceContext {
  db: Db;
  bus: EventBus;
  registry: ModelRegistry;
  store: AssetStore;
  config: ServerConfig;
  hooks: EngineHooks;
}

export type PendingEvent = EventInput;
export type Emit = (event: PendingEvent) => void;
export type DbLike = Db | Tx;

/** One SQLite transaction; events are emitted after commit, in order. */
export function transact<T>(ctx: ServiceContext, fn: (tx: Tx, emit: Emit) => T): T {
  const pending: PendingEvent[] = [];
  const result = ctx.db.transaction((tx) => fn(tx, (e) => pending.push(e)));
  for (const e of pending) ctx.bus.emit(e);
  return result;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function toColumn(r: ColumnRow): Column {
  return { id: r.id, model: r.model, ...(r.settings ? { settings: r.settings } : {}), count: r.count, position: r.position };
}

export function toRow(r: RowRow): Row {
  return {
    id: r.id,
    prompt: r.prompt,
    ...(r.negativePrompt !== null ? { negativePrompt: r.negativePrompt } : {}),
    inputs: r.inputs,
    ...(r.settings ? { settings: r.settings } : {}),
    paused: r.paused,
    position: r.position,
    ...(r.notes !== null ? { notes: r.notes } : {}),
  };
}

export function toGeneration(g: GenerationRow): Generation {
  return {
    id: g.id,
    collection: g.collection,
    row: g.row,
    column: g.column,
    version: g.version,
    requestHash: g.requestHash,
    request: g.request,
    status: g.status,
    ...(g.providerRef ? { providerRef: g.providerRef } : {}),
    ...(g.pendingOutputs ? { pendingOutputs: g.pendingOutputs } : {}),
    outputs: g.outputs,
    ...(g.error ? { error: g.error } : {}),
    attempt: g.attempt,
    forced: g.forced,
    timing: {
      queuedAt: g.queuedAt,
      ...(g.startedAt ? { startedAt: g.startedAt } : {}),
      ...(g.finishedAt ? { finishedAt: g.finishedAt } : {}),
    },
    ...(g.cost !== null ? { cost: g.cost } : {}),
    ...(g.providerMeta !== null && g.providerMeta !== undefined ? { providerMeta: g.providerMeta } : {}),
  };
}

export function toAsset(a: AssetRow): Asset {
  return {
    id: a.id,
    kind: a.kind,
    origin: a.originType === 'upload' ? { type: 'upload' } : { type: 'generation', generation: a.originGeneration ?? '' },
    mime: a.mime,
    width: a.width,
    height: a.height,
    bytes: a.bytes,
    sha256: a.sha256,
    ...(a.label !== null ? { label: a.label } : {}),
    createdAt: a.createdAt,
  };
}

export function toAssetView(a: AssetRow): AssetView {
  return { ...toAsset(a), url: assetUrl(a.id), thumbUrl: assetThumbUrl(a.id) };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export function loadCollection(db: DbLike, slug: string): Collection | undefined {
  const c = db.select().from(collections).where(eq(collections.slug, slug)).get();
  if (!c) return undefined;
  const cols = db.select().from(columns).where(eq(columns.collection, slug)).orderBy(asc(columns.position), asc(columns.id)).all();
  const rs = db.select().from(rows).where(eq(rows.collection, slug)).orderBy(asc(rows.position), asc(rows.id)).all();
  return {
    slug: c.slug,
    title: c.title,
    ...(c.description !== null ? { description: c.description } : {}),
    status: c.status,
    defaults: c.defaults,
    columns: cols.map(toColumn),
    rows: rs.map(toRow),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function requireCollection(db: DbLike, slug: string): Collection {
  const c = loadCollection(db, slug);
  if (!c) throw notFound(`collection ${slug}`);
  return c;
}

export function requireRowRow(db: DbLike, collection: string, id: string): RowRow {
  const r = db.select().from(rows).where(and(eq(rows.collection, collection), eq(rows.id, id))).get();
  if (!r) throw notFound(`row ${collection}/${id}`);
  return r;
}

export function requireColumnRow(db: DbLike, collection: string, id: string): ColumnRow {
  const c = db.select().from(columns).where(and(eq(columns.collection, collection), eq(columns.id, id))).get();
  if (!c) throw notFound(`column ${collection}/${id}`);
  return c;
}

export function loadAssetsById(db: DbLike, ids: Iterable<string>): Map<string, AssetRow> {
  const list = [...new Set(ids)];
  const out = new Map<string, AssetRow>();
  if (list.length === 0) return out;
  for (const a of db.select().from(assets).where(inArray(assets.id, list)).all()) out.set(a.id, a);
  return out;
}

/**
 * Asset lookup for `resolveCell()`: every asset referenced by a row input is
 * preloaded; anything else (row references resolve to generation outputs) is
 * fetched on first use and cached.
 */
export function assetLookupFor(db: DbLike, collection: Collection): (id: string) => Asset | undefined {
  const ids = collection.rows.flatMap((r) => r.inputs.flatMap((i) => (isRowRef(i) ? [] : [i.asset])));
  const map = new Map<string, Asset | undefined>();
  for (const [id, a] of loadAssetsById(db, ids)) map.set(id, toAsset(a));
  for (const id of ids) if (!map.has(id)) map.set(id, undefined);
  return (id) => {
    if (!map.has(id)) {
      const a = db.select().from(assets).where(eq(assets.id, id)).get();
      map.set(id, a ? toAsset(a) : undefined);
    }
    return map.get(id);
  };
}

export function touchCollection(db: DbLike, slug: string): void {
  db.update(collections).set({ updatedAt: nowIso() }).where(eq(collections.slug, slug)).run();
}

// ---------------------------------------------------------------------------
// IDs and generation insertion
// ---------------------------------------------------------------------------

export function newGenerationId(db: DbLike): string {
  for (let i = 0; i < 20; i++) {
    const id = randomId();
    if (!db.select({ id: generations.id }).from(generations).where(eq(generations.id, id)).get()) return id;
  }
  throw new Error('could not allocate a generation id');
}

export function newAssetId(db: DbLike): string {
  for (let i = 0; i < 20; i++) {
    const id = randomId();
    if (!db.select({ id: assets.id }).from(assets).where(eq(assets.id, id)).get()) return id;
  }
  throw new Error('could not allocate an asset id');
}

export interface InsertGenerationInput {
  collection: string;
  row: string;
  column: string;
  requestHash: string;
  request: ResolvedRequest;
  unsupported: string[];
  forced: boolean;
}

/** Insert a generation with the next version ordinal in its cell; emits generation.updated. */
export function insertGeneration(tx: Tx, emit: Emit, input: InsertGenerationInput): GenerationRow {
  const id = newGenerationId(tx);
  const maxVersion = tx
    .select({ v: sql<number | null>`max(${generations.version})` })
    .from(generations)
    .where(and(eq(generations.collection, input.collection), eq(generations.row, input.row), eq(generations.column, input.column)))
    .get()?.v;
  const maxSeq = tx.select({ s: sql<number | null>`max(${generations.seq})` }).from(generations).get()?.s;
  const now = nowIso();
  const unsupported = input.unsupported.length > 0;
  const row: GenerationRow = {
    id,
    seq: (maxSeq ?? 0) + 1,
    collection: input.collection,
    row: input.row,
    column: input.column,
    version: (maxVersion ?? 0) + 1,
    requestHash: input.requestHash,
    request: input.request,
    status: unsupported ? 'unsupported' : 'queued',
    providerRef: null,
    pendingOutputs: null,
    outputs: [],
    error: unsupported ? { message: input.unsupported.join('; '), code: 'unsupported', retryable: false } : null,
    attempt: 1,
    forced: input.forced,
    queuedAt: now,
    startedAt: null,
    finishedAt: unsupported ? now : null,
    cost: null,
    providerMeta: null,
  };
  tx.insert(generations).values(row).run();
  emit({ type: 'generation.updated', id, collection: input.collection, row: input.row, column: input.column, status: row.status });
  return row;
}
