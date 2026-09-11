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
/** `provider/model`; the model part may itself contain slashes (fal: `fal/fal-ai/flux-pro/v1.1`). */
export const MODEL_ID_RE = /^[a-z0-9-]+\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

export const slugSchema = z.string().regex(SLUG_RE, 'must be a lowercase slug (a-z, 0-9, hyphens)');
export const collectionSlugSchema = slugSchema;
export const columnIdSchema = slugSchema;
export const rowIdSchema = z.string().regex(ROW_ID_RE, 'row ids look like r1, r2, ...');
export const assetIdSchema = z.string().regex(RANDOM_ID_RE, 'asset ids are 6 lowercase characters');
export const generationIdSchema = z.string().regex(RANDOM_ID_RE, 'generation ids are 6 lowercase characters');
export const modelIdSchema = z.string().regex(MODEL_ID_RE, 'model ids look like provider/model (the model part may contain slashes)');

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

// ---------------------------------------------------------------------------
// References: partial cell addresses (DESIGN §3, References)
// ---------------------------------------------------------------------------

export interface ReferenceAnchors {
  collection?: CollectionSlug;
  row?: RowId;
  column?: ColumnId;
}

/**
 * `r3` → row; `flux` → column; `r3/flux` → row + column;
 * `coll/r3/flux` → all three. Row ids are the only segment shaped `r<digits>`,
 * so a bare segment is never ambiguous.
 */
export function parseReference(input: string): ReferenceAnchors {
  const parts = input.trim().split('/');
  const bad = () => new AddressError(`not a reference (r3, column, r3/column, or collection/r3/column): ${input}`);
  if (parts.some((p) => p === '')) throw bad();
  if (parts.length === 1) {
    const [a] = parts as [string];
    if (ROW_ID_RE.test(a)) return { row: a };
    if (SLUG_RE.test(a)) return { column: a };
    throw bad();
  }
  if (parts.length === 2) {
    const [r, c] = parts as [string, string];
    if (!ROW_ID_RE.test(r) || !SLUG_RE.test(c)) throw bad();
    return { row: r, column: c };
  }
  if (parts.length === 3) {
    const [coll, r, c] = parts as [string, string, string];
    if (!SLUG_RE.test(coll) || !ROW_ID_RE.test(r) || !SLUG_RE.test(c)) throw bad();
    return { collection: coll, row: r, column: c };
  }
  throw bad();
}

/** Shortest address for `target` as seen from `origin`: `r3`, `r3/flux`, or `coll/r3/flux`. */
export function formatReference(target: CellAddress, origin: CellAddress): string {
  if (target.collection !== origin.collection) return formatCellAddress(target);
  if (target.column !== origin.column) return `${target.row}/${target.column}`;
  return target.row;
}

/** Address of a cell as named in messages: `r3/flux` inside the same collection, full elsewhere. */
export function formatCellLabel(target: CellAddress, origin: CellAddress): string {
  return target.collection === origin.collection ? `${target.row}/${target.column}` : formatCellAddress(target);
}

export function cellKeyOf(a: CellAddress): string {
  return `${a.collection}/${a.row}/${a.column}`;
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
