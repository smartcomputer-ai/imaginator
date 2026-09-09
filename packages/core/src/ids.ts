import { z } from 'zod';

/** Alphabet for random IDs: no 0/o/1/l/i, so IDs survive being read aloud or typed. */
export const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const RANDOM_ID_LENGTH = 6;

export function randomId(length = RANDOM_ID_LENGTH, random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  return out;
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const ROW_ID_RE = /^r[1-9][0-9]*$/;
export const RANDOM_ID_RE = new RegExp(`^[${ID_ALPHABET}]{${RANDOM_ID_LENGTH}}$`);
export const MODEL_ID_RE = /^[a-z0-9-]+\/[a-z0-9][a-z0-9._-]*$/;

export const slugSchema = z.string().regex(SLUG_RE, 'must be a lowercase slug (a-z, 0-9, hyphens)');
export const collectionSlugSchema = slugSchema;
export const columnIdSchema = slugSchema;
export const rowIdSchema = z.string().regex(ROW_ID_RE, 'row ids look like r1, r2, ...');
export const assetIdSchema = z.string().regex(RANDOM_ID_RE, 'asset ids are 6 lowercase characters');
export const generationIdSchema = z.string().regex(RANDOM_ID_RE, 'generation ids are 6 lowercase characters');
export const modelIdSchema = z.string().regex(MODEL_ID_RE, 'model ids look like provider/model');

export type CollectionSlug = string;
export type ColumnId = string;
export type RowId = string;
export type AssetId = string;
export type GenerationId = string;
export type ModelId = string;

/** Converts free text to a slug, or returns '' if nothing usable remains. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

export function rowNumber(rowId: RowId): number {
  return Number(rowId.slice(1));
}

// ---------------------------------------------------------------------------
// Readable addresses
// ---------------------------------------------------------------------------

export interface CellAddress {
  collection: CollectionSlug;
  row: RowId;
  column: ColumnId;
}

/** `neon-cats/r3/flux-pro#2` → cell + optional version. `q7m2kd` → id. */
export type GenerationRef = { id: GenerationId } | (CellAddress & { version?: number });

export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressError';
  }
}

const CELL_ADDRESS_RE = new RegExp(
  `^(${SLUG_RE.source.slice(1, -1)})\\/(${ROW_ID_RE.source.slice(1, -1)})\\/(${SLUG_RE.source.slice(1, -1)})(?:#([1-9][0-9]*))?$`,
);

export function parseCellAddress(input: string): CellAddress {
  const m = CELL_ADDRESS_RE.exec(input.trim());
  if (!m || m[4] !== undefined) throw new AddressError(`not a cell address (collection/row/column): ${input}`);
  return { collection: m[1]!, row: m[2]!, column: m[3]! };
}

export function formatCellAddress(a: CellAddress, version?: number): string {
  return `${a.collection}/${a.row}/${a.column}${version === undefined ? '' : `#${version}`}`;
}

export function parseGenerationRef(input: string): GenerationRef {
  const trimmed = input.trim();
  if (RANDOM_ID_RE.test(trimmed)) return { id: trimmed };
  const m = CELL_ADDRESS_RE.exec(trimmed);
  if (!m) throw new AddressError(`not a generation reference (id or collection/row/column#version): ${input}`);
  const ref: GenerationRef = { collection: m[1]!, row: m[2]!, column: m[3]! };
  if (m[4] !== undefined) ref.version = Number(m[4]);
  return ref;
}

export const cellAddressSchema = z
  .string()
  .transform((s, ctx) => {
    try {
      return parseCellAddress(s);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: (e as Error).message });
      return z.NEVER;
    }
  });

export const generationRefSchema = z
  .string()
  .transform((s, ctx) => {
    try {
      return parseGenerationRef(s);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: (e as Error).message });
      return z.NEVER;
    }
  });
