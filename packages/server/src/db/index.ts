import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { schema } from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Migrations as plain SQL, executed at boot. Idempotent (`IF NOT EXISTS`);
 * later schema changes append statements here.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS collections (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL,
    defaults TEXT NOT NULL,
    next_row INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS columns (
    collection TEXT NOT NULL REFERENCES collections(slug) ON DELETE CASCADE ON UPDATE CASCADE,
    id TEXT NOT NULL,
    model TEXT NOT NULL,
    settings TEXT,
    count INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL,
    PRIMARY KEY (collection, id)
  )`,
  `CREATE TABLE IF NOT EXISTS rows (
    collection TEXT NOT NULL REFERENCES collections(slug) ON DELETE CASCADE ON UPDATE CASCADE,
    id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    negative_prompt TEXT,
    inputs TEXT NOT NULL,
    settings TEXT,
    paused INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL,
    notes TEXT,
    PRIMARY KEY (collection, id)
  )`,
  `CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    collection TEXT NOT NULL REFERENCES collections(slug) ON DELETE CASCADE ON UPDATE CASCADE,
    row TEXT NOT NULL,
    column TEXT NOT NULL,
    version INTEGER NOT NULL,
    request_hash TEXT NOT NULL,
    request TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_ref TEXT,
    pending_outputs TEXT,
    outputs TEXT NOT NULL,
    error TEXT,
    attempt INTEGER NOT NULL DEFAULT 1,
    forced INTEGER NOT NULL DEFAULT 0,
    queued_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    cost REAL,
    provider_meta TEXT,
    FOREIGN KEY (collection, row) REFERENCES rows(collection, id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (collection, column) REFERENCES columns(collection, id) ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS generations_cell_idx ON generations(collection, row, column, version)`,
  `CREATE INDEX IF NOT EXISTS generations_cell_hash_idx ON generations(collection, row, column, request_hash)`,
  `CREATE INDEX IF NOT EXISTS generations_status_seq_idx ON generations(status, seq)`,
  `CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    origin_type TEXT NOT NULL,
    origin_generation TEXT,
    mime TEXT NOT NULL,
    ext TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS assets_sha256_idx ON assets(sha256)`,
  `CREATE INDEX IF NOT EXISTS assets_created_idx ON assets(created_at)`,
  `CREATE TABLE IF NOT EXISTS cell_pins (
    collection TEXT NOT NULL,
    row TEXT NOT NULL,
    column TEXT NOT NULL,
    generation TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    PRIMARY KEY (collection, row, column),
    FOREIGN KEY (collection, row) REFERENCES rows(collection, id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (collection, column) REFERENCES columns(collection, id) ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS cell_holds (
    collection TEXT NOT NULL,
    row TEXT NOT NULL,
    column TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    PRIMARY KEY (collection, row, column),
    FOREIGN KEY (collection, row) REFERENCES rows(collection, id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (collection, column) REFERENCES columns(collection, id) ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS refs (
    from_collection TEXT NOT NULL REFERENCES collections(slug) ON DELETE CASCADE ON UPDATE CASCADE,
    from_kind TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_collection TEXT NOT NULL,
    to_row TEXT,
    to_column TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS refs_from_idx ON refs(from_collection, from_kind, from_id)`,
  `CREATE INDEX IF NOT EXISTS refs_to_idx ON refs(to_collection, to_row, to_column)`,
];

/** Columns added after the first release; applied when missing. */
const ADDED_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'columns', column: 'prompt', ddl: 'prompt TEXT' },
  { table: 'columns', column: 'negative_prompt', ddl: 'negative_prompt TEXT' },
  { table: 'columns', column: 'inputs', ddl: 'inputs TEXT' },
  { table: 'rows', column: 'columns', ddl: 'columns TEXT' },
];

export interface OpenDb {
  db: Db;
  sqlite: Database.Database;
  close(): void;
}

export function openDb(file: string): OpenDb {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  for (const sql of MIGRATIONS) sqlite.exec(sql);
  for (const add of ADDED_COLUMNS) {
    const existing = (sqlite.pragma(`table_info(${add.table})`) as Array<{ name: string }>).map((c) => c.name);
    if (!existing.includes(add.column)) sqlite.exec(`ALTER TABLE ${add.table} ADD COLUMN ${add.ddl}`);
  }
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}

export function nowIso(): string {
  return new Date().toISOString();
}
