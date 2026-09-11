import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  CommonSettings,
  GenerationError,
  GenerationStatus,
  Input,
  JsonObject,
  JsonValue,
  PendingOutput,
  ProviderRef,
  ResolvedRequest,
} from '@imaginator/core';

export const collections = sqliteTable('collections', {
  slug: text('slug').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').$type<'live' | 'paused'>().notNull(),
  defaults: text('defaults', { mode: 'json' }).$type<CommonSettings>().notNull(),
  /** Next row number to hand out; never reused. */
  nextRow: integer('next_row').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const columns = sqliteTable(
  'columns',
  {
    collection: text('collection')
      .notNull()
      .references(() => collections.slug, { onDelete: 'cascade', onUpdate: 'cascade' }),
    id: text('id').notNull(),
    model: text('model').notNull(),
    settings: text('settings', { mode: 'json' }).$type<JsonObject | null>(),
    count: integer('count').notNull().default(1),
    position: integer('position').notNull(),
    /** Recipe: prompt template; null = '{prompt}'. */
    prompt: text('prompt'),
    /** Recipe: negative prompt template; null = '{negativePrompt}'. */
    negativePrompt: text('negative_prompt'),
    /** Recipe: replacement inputs; null = inherit the row's inputs. */
    inputs: text('inputs', { mode: 'json' }).$type<Input[] | null>(),
  },
  (t) => [primaryKey({ columns: [t.collection, t.id] })],
);

export const rows = sqliteTable(
  'rows',
  {
    collection: text('collection')
      .notNull()
      .references(() => collections.slug, { onDelete: 'cascade', onUpdate: 'cascade' }),
    id: text('id').notNull(),
    prompt: text('prompt').notNull(),
    negativePrompt: text('negative_prompt'),
    inputs: text('inputs', { mode: 'json' }).$type<Input[]>().notNull(),
    settings: text('settings', { mode: 'json' }).$type<CommonSettings | null>(),
    paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
    position: integer('position').notNull(),
    notes: text('notes'),
    /** Sparse row: run only in these columns; null = every column. */
    columns: text('columns', { mode: 'json' }).$type<string[] | null>(),
  },
  (t) => [primaryKey({ columns: [t.collection, t.id] })],
);

/** A pinned generation per cell (DESIGN §3, Pins). Applies only while its hash matches the desired hash. */
export const cellPins = sqliteTable(
  'cell_pins',
  {
    collection: text('collection').notNull(),
    row: text('row').notNull(),
    column: text('column').notNull(),
    generation: text('generation').notNull(),
  },
  (t) => [primaryKey({ columns: [t.collection, t.row, t.column] })],
);

/** An explicit cancellation hold: the desired hash is not recreated until retry/regenerate. */
export const cellHolds = sqliteTable(
  'cell_holds',
  {
    collection: text('collection').notNull(),
    row: text('row').notNull(),
    column: text('column').notNull(),
    requestHash: text('request_hash').notNull(),
  },
  (t) => [primaryKey({ columns: [t.collection, t.row, t.column] })],
);

/**
 * Reference index: every live input as written, by the row or column that
 * carries it. `toRow`/`toColumn` are null for the relative anchor.
 */
export const refs = sqliteTable(
  'refs',
  {
    fromCollection: text('from_collection').notNull(),
    fromKind: text('from_kind').$type<'row' | 'column'>().notNull(),
    fromId: text('from_id').notNull(),
    toCollection: text('to_collection').notNull(),
    toRow: text('to_row'),
    toColumn: text('to_column'),
  },
  (t) => [index('refs_from_idx').on(t.fromCollection, t.fromKind, t.fromId), index('refs_to_idx').on(t.toCollection, t.toRow, t.toColumn)],
);

export const generations = sqliteTable(
  'generations',
  {
    id: text('id').primaryKey(),
    /** Monotonic insertion order (rowid alias); the runner picks oldest first by this. */
    seq: integer('seq').notNull(),
    collection: text('collection').notNull(),
    row: text('row').notNull(),
    column: text('column').notNull(),
    version: integer('version').notNull(),
    requestHash: text('request_hash').notNull(),
    request: text('request', { mode: 'json' }).$type<ResolvedRequest>().notNull(),
    status: text('status').$type<GenerationStatus>().notNull(),
    providerRef: text('provider_ref', { mode: 'json' }).$type<ProviderRef | null>(),
    pendingOutputs: text('pending_outputs', { mode: 'json' }).$type<PendingOutput[] | null>(),
    outputs: text('outputs', { mode: 'json' }).$type<string[]>().notNull(),
    error: text('error', { mode: 'json' }).$type<GenerationError | null>(),
    attempt: integer('attempt').notNull().default(1),
    forced: integer('forced', { mode: 'boolean' }).notNull().default(false),
    queuedAt: text('queued_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    cost: real('cost'),
    providerMeta: text('provider_meta', { mode: 'json' }).$type<JsonValue | null>(),
  },
  (t) => [
    index('generations_cell_idx').on(t.collection, t.row, t.column, t.version),
    index('generations_cell_hash_idx').on(t.collection, t.row, t.column, t.requestHash),
    index('generations_status_seq_idx').on(t.status, t.seq),
  ],
);

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<'image' | 'video'>().notNull(),
    originType: text('origin_type').$type<'upload' | 'generation'>().notNull(),
    originGeneration: text('origin_generation'),
    mime: text('mime').notNull(),
    ext: text('ext').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    label: text('label'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('assets_sha256_idx').on(t.sha256), index('assets_created_idx').on(t.createdAt)],
);

export const schema = { collections, columns, rows, generations, assets, cellPins, cellHolds, refs };
export type CellPinRow = typeof cellPins.$inferSelect;
export type CellHoldRow = typeof cellHolds.$inferSelect;
export type RefRow = typeof refs.$inferSelect;
export type CollectionRow = typeof collections.$inferSelect;
export type ColumnRow = typeof columns.$inferSelect;
export type RowRow = typeof rows.$inferSelect;
export type GenerationRow = typeof generations.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
