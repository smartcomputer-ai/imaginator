import type { CollectionSlug, ColumnId, GenerationId, RowId, AssetId } from './ids.js';
import type { GenerationStatus } from './domain.js';

/**
 * Cursor: `<bootId>.<seq>`, per collection. Opaque to clients; the server
 * treats a cursor from another boot as stale.
 */
export type Cursor = string;

export function formatCursor(bootId: string, seq: number): Cursor {
  return `${bootId}.${seq}`;
}

export function parseCursor(cursor: Cursor): { bootId: string; seq: number } | undefined {
  const i = cursor.lastIndexOf('.');
  if (i < 0) return undefined;
  const seq = Number(cursor.slice(i + 1));
  if (!Number.isInteger(seq) || seq < 0) return undefined;
  return { bootId: cursor.slice(0, i), seq };
}

export type ImaginatorEvent =
  | { type: 'collection.created'; collection: CollectionSlug; cursor: Cursor }
  | { type: 'collection.updated'; collection: CollectionSlug; cursor: Cursor }
  | { type: 'collection.deleted'; collection: CollectionSlug; cursor: Cursor }
  | { type: 'row.updated'; collection: CollectionSlug; row: RowId; cursor: Cursor }
  | { type: 'row.deleted'; collection: CollectionSlug; row: RowId; cursor: Cursor }
  | { type: 'column.updated'; collection: CollectionSlug; column: ColumnId; cursor: Cursor }
  | { type: 'column.deleted'; collection: CollectionSlug; column: ColumnId; cursor: Cursor }
  | {
      type: 'generation.updated';
      id: GenerationId;
      collection: CollectionSlug;
      row: RowId;
      column: ColumnId;
      status: GenerationStatus;
      cursor: Cursor;
    }
  | { type: 'asset.created'; id: AssetId; cursor?: Cursor };

export type EventType = ImaginatorEvent['type'];
