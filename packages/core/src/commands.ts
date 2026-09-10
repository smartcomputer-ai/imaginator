import { z } from 'zod';
import {
  assetSchema,
  collectionSchema,
  collectionStatusSchema,
  columnSchema,
  generationErrorSchema,
  generationSchema,
  generationStatusSchema,
  generationTimingSchema,
  inputsSchema,
  rowSchema,
} from './domain.js';
import {
  assetIdSchema,
  cellAddressSchema,
  collectionSlugSchema,
  columnIdSchema,
  generationRefSchema,
  modelIdSchema,
  rowIdSchema,
} from './ids.js';
import { jsonObjectSchema, jsonValueSchema } from './json.js';
import { commonKeySchema, commonSettingsSchema, modelSettingsSchema } from './settings.js';

// ---------------------------------------------------------------------------
// Shared view schemas
// ---------------------------------------------------------------------------

export const cursorSchema = z.string().describe('Per-collection change cursor; opaque');

export const CELL_STATUSES = [...generationStatusSchema.options, 'missing', 'blocked'] as const;
export const cellStatusSchema = z.enum(CELL_STATUSES);
export type CellStatus = (typeof CELL_STATUSES)[number];

export const cellViewSchema = z.object({
  row: rowIdSchema,
  column: columnIdSchema,
  address: z.string().describe('collection/row/column'),
  hash: z.string().describe('Desired requestHash for this cell'),
  /**
   * `missing` = no generation yet for the desired hash (reconcile pending or
   * paused). `blocked` = a row-reference input has no output yet; see `blocked`.
   */
  status: cellStatusSchema,
  blocked: z.string().optional().describe('Why the cell cannot resolve yet, e.g. "waiting for r3"'),
  generation: z.string().optional().describe('Current generation id'),
  version: z.number().int().optional(),
  versions: z.number().int().describe('Non-cancelled generations in this cell, any hash'),
  outputs: z.array(assetIdSchema),
  urls: z.array(z.string()),
  thumbnails: z.array(z.string()),
  error: generationErrorSchema.optional(),
  droppedKeys: z.array(commonKeySchema).optional(),
  timing: generationTimingSchema.optional(),
  cost: z.number().optional().describe('Estimated USD of the current generation'),
});
export type CellView = z.infer<typeof cellViewSchema>;

export const collectionViewSchema = collectionSchema.extend({
  cells: z.array(cellViewSchema),
  cursor: cursorSchema,
  inFlight: z.number().int().describe('Generations in submitting/running/downloading'),
  queued: z.number().int(),
});
export type CollectionView = z.infer<typeof collectionViewSchema>;

export const collectionSummarySchema = z.object({
  slug: collectionSlugSchema,
  title: z.string(),
  description: z.string().optional(),
  status: collectionStatusSchema,
  rows: z.number().int(),
  columns: z.number().int(),
  cells: z.number().int(),
  succeeded: z.number().int(),
  inFlight: z.number().int(),
  queued: z.number().int(),
  failed: z.number().int().describe('failed + unsupported + needs_attention'),
  cursor: cursorSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CollectionSummary = z.infer<typeof collectionSummarySchema>;

export const modelInfoSchema = z.object({
  id: modelIdSchema,
  name: z.string(),
  provider: z.string(),
  kind: z.enum(['image', 'video']),
  description: z.string().optional(),
  pricing: z.string().optional().describe('Human-readable list price; per-generation cost is estimated from it'),
  capabilities: z.object({
    inputRoles: z.array(z.string()),
    maxInputImages: z.number().int(),
    negativePrompt: z.boolean(),
    commonKeys: z.array(commonKeySchema),
    count: z.number().int(),
    aspectRatios: z.array(z.string()).optional(),
    sizes: z.array(z.string()).optional(),
    outputFormats: z.array(z.string()).optional(),
  }),
  settingsSchema: jsonValueSchema.describe('JSON Schema of the model-specific settings'),
  settingsDefaults: jsonObjectSchema,
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

export const generationSummarySchema = generationSchema.pick({
  id: true,
  version: true,
  requestHash: true,
  status: true,
  outputs: true,
  error: true,
  forced: true,
  attempt: true,
  timing: true,
  cost: true,
});
export type GenerationSummary = z.infer<typeof generationSummarySchema>;

export const assetViewSchema = assetSchema.extend({
  url: z.string(),
  thumbUrl: z.string(),
});
export type AssetView = z.infer<typeof assetViewSchema>;

// ---------------------------------------------------------------------------
// Input fragments
// ---------------------------------------------------------------------------

export const columnInputSchema = z.object({
  id: columnIdSchema.optional().describe("Defaults to the model's short name, de-duplicated"),
  model: modelIdSchema,
  settings: modelSettingsSchema.optional(),
  count: z.number().int().min(1).optional(),
  position: z.number().int().min(0).optional(),
});
export type ColumnInput = z.infer<typeof columnInputSchema>;

export const rowInputSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  inputs: inputsSchema.optional(),
  settings: commonSettingsSchema.optional(),
  paused: z.boolean().optional(),
  notes: z.string().optional(),
  position: z.number().int().min(0).optional(),
});
export type RowInput = z.infer<typeof rowInputSchema>;

export const collectionExportSchema = z.object({
  version: z.literal(1),
  collection: z.object({
    slug: collectionSlugSchema,
    title: z.string(),
    description: z.string().optional(),
    status: collectionStatusSchema,
    defaults: commonSettingsSchema,
  }),
  columns: z.array(columnSchema),
  rows: z.array(rowSchema),
  /** Metadata of every asset referenced as a row input. */
  assets: z.array(assetSchema),
  exportedAt: z.string(),
});
export type CollectionExport = z.infer<typeof collectionExportSchema>;

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

export type CommandKind = 'read' | 'write';

export interface CommandDef<Name extends string = string, I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny> {
  name: Name;
  kind: CommandKind;
  description: string;
  input: I;
  output: O;
  /** Read commands whose output references image assets; MCP attaches them. */
  images?: boolean;
}

function def<Name extends string, I extends z.ZodTypeAny, O extends z.ZodTypeAny>(d: CommandDef<Name, I, O>): CommandDef<Name, I, O> {
  return d;
}

const collectionArg = collectionSlugSchema.describe('Collection slug');
const cursorOut = { cursor: cursorSchema };

export const commandDefs = {
  'models.list': def({
    name: 'models.list',
    kind: 'read',
    description: 'List available models with capabilities and their settings schema.',
    input: z.object({}),
    output: z.object({ models: z.array(modelInfoSchema), registryVersion: z.string() }),
  }),

  'collections.list': def({
    name: 'collections.list',
    kind: 'read',
    description: 'List collections with status and cell counts.',
    input: z.object({}),
    output: z.object({ collections: z.array(collectionSummarySchema) }),
  }),
  'collections.get': def({
    name: 'collections.get',
    kind: 'read',
    images: true,
    description: 'Get a whole collection: rows, columns, defaults, and every cell with its current status and outputs.',
    input: z.object({ collection: collectionArg }),
    output: collectionViewSchema,
  }),
  'collections.create': def({
    name: 'collections.create',
    kind: 'write',
    description: 'Create a collection. Live by default: rows × columns generate immediately.',
    input: z.object({
      slug: collectionSlugSchema,
      title: z.string().optional(),
      description: z.string().optional(),
      status: collectionStatusSchema.optional(),
      defaults: commonSettingsSchema.optional(),
      columns: z.array(columnInputSchema).optional(),
      rows: z.array(rowInputSchema).optional(),
    }),
    output: collectionViewSchema,
  }),
  'collections.update': def({
    name: 'collections.update',
    kind: 'write',
    description: 'Update title, description, or default common settings (replaces defaults wholesale when given).',
    input: z.object({
      collection: collectionArg,
      title: z.string().optional(),
      description: z.string().nullable().optional(),
      defaults: commonSettingsSchema.optional(),
    }),
    output: collectionViewSchema,
  }),
  'collections.delete': def({
    name: 'collections.delete',
    kind: 'write',
    description: 'Delete a collection and its generations. Assets are kept.',
    input: z.object({ collection: collectionArg }),
    output: z.object({ ok: z.literal(true) }),
  }),
  'collections.pause': def({
    name: 'collections.pause',
    kind: 'write',
    description: 'Pause: edit freely, nothing generates. Queued work is cancelled.',
    input: z.object({ collection: collectionArg }),
    output: collectionViewSchema,
  }),
  'collections.resume': def({
    name: 'collections.resume',
    kind: 'write',
    description: 'Resume a paused collection; one reconcile pass fills every missing cell.',
    input: z.object({ collection: collectionArg }),
    output: collectionViewSchema,
  }),
  'collections.duplicate': def({
    name: 'collections.duplicate',
    kind: 'write',
    description: 'Copy structure (defaults, columns, rows) into a new collection. Paused by default; no generations copied.',
    input: z.object({
      collection: collectionArg,
      slug: collectionSlugSchema,
      title: z.string().optional(),
      status: collectionStatusSchema.optional(),
    }),
    output: collectionViewSchema,
  }),
  'collections.rename': def({
    name: 'collections.rename',
    kind: 'write',
    description: 'Change a collection slug; all references are rewritten.',
    input: z.object({ collection: collectionArg, slug: collectionSlugSchema }),
    output: collectionViewSchema,
  }),
  'collections.export': def({
    name: 'collections.export',
    kind: 'read',
    description: 'Export a collection as one JSON document (structure + referenced asset metadata).',
    input: z.object({ collection: collectionArg }),
    output: z.object({ document: collectionExportSchema }),
  }),
  'collections.import': def({
    name: 'collections.import',
    kind: 'write',
    description: 'Import a collection document. Referenced input assets must already exist locally.',
    input: z.object({
      document: collectionExportSchema,
      slug: collectionSlugSchema.optional().describe('Override the slug in the document'),
      status: collectionStatusSchema.optional(),
    }),
    output: collectionViewSchema,
  }),
  'collections.wait': def({
    name: 'collections.wait',
    kind: 'read',
    description:
      'Block until the collection cursor moves past the given one or the timeout elapses. Loop: mutate → wait(cursor) → get, while inFlight or queued > 0.',
    input: z.object({
      collection: collectionArg,
      cursor: cursorSchema,
      timeoutMs: z.number().int().min(0).max(120_000).optional().describe('Default 30000'),
    }),
    output: z.object({
      ...cursorOut,
      changed: z.boolean(),
      inFlight: z.number().int(),
      queued: z.number().int(),
    }),
  }),

  'columns.add': def({
    name: 'columns.add',
    kind: 'write',
    description: 'Add a column (a model plus optional model settings and count). Every row gets a new cell.',
    input: z.object({ collection: collectionArg, ...columnInputSchema.shape }),
    output: z.object({ column: columnSchema, ...cursorOut }),
  }),
  'columns.update': def({
    name: 'columns.update',
    kind: 'write',
    description: 'Update a column. `settings` replaces the whole bag when given; null clears it.',
    input: z.object({
      collection: collectionArg,
      column: columnIdSchema,
      id: columnIdSchema.optional().describe('Rename the column'),
      model: modelIdSchema.optional(),
      settings: modelSettingsSchema.nullable().optional(),
      count: z.number().int().min(1).optional(),
      position: z.number().int().min(0).optional(),
    }),
    output: z.object({ column: columnSchema, ...cursorOut }),
  }),
  'columns.remove': def({
    name: 'columns.remove',
    kind: 'write',
    description: 'Remove a column and its generations (assets are kept).',
    input: z.object({ collection: collectionArg, column: columnIdSchema }),
    output: z.object(cursorOut),
  }),
  'columns.reorder': def({
    name: 'columns.reorder',
    kind: 'write',
    description: 'Set column order. Columns not listed keep their relative order after the listed ones.',
    input: z.object({ collection: collectionArg, order: z.array(columnIdSchema) }),
    output: z.object({ columns: z.array(columnSchema), ...cursorOut }),
  }),

  'rows.add': def({
    name: 'rows.add',
    kind: 'write',
    description: 'Add one or more rows (prompts with inputs and settings). Bulk-friendly.',
    input: z.object({ collection: collectionArg, rows: z.array(rowInputSchema).min(1) }),
    output: z.object({ rows: z.array(rowSchema), ...cursorOut }),
  }),
  'rows.update': def({
    name: 'rows.update',
    kind: 'write',
    description: 'Update a row. Optional fields set to null are cleared; `inputs` and `settings` replace wholesale.',
    input: z.object({
      collection: collectionArg,
      row: rowIdSchema,
      prompt: z.string().optional(),
      negativePrompt: z.string().nullable().optional(),
      inputs: inputsSchema.optional(),
      settings: commonSettingsSchema.nullable().optional(),
      notes: z.string().nullable().optional(),
      position: z.number().int().min(0).optional(),
    }),
    output: z.object({ row: rowSchema, ...cursorOut }),
  }),
  'rows.remove': def({
    name: 'rows.remove',
    kind: 'write',
    description: 'Remove rows and their generations (assets are kept).',
    input: z.object({ collection: collectionArg, rows: z.array(rowIdSchema).min(1) }),
    output: z.object(cursorOut),
  }),
  'rows.reorder': def({
    name: 'rows.reorder',
    kind: 'write',
    description: 'Set row order. Rows not listed keep their relative order after the listed ones.',
    input: z.object({ collection: collectionArg, order: z.array(rowIdSchema) }),
    output: z.object({ rows: z.array(rowSchema), ...cursorOut }),
  }),
  'rows.pause': def({
    name: 'rows.pause',
    kind: 'write',
    description: 'Pause rows: their cells stop generating; queued work is cancelled.',
    input: z.object({ collection: collectionArg, rows: z.array(rowIdSchema).min(1) }),
    output: z.object({ rows: z.array(rowSchema), ...cursorOut }),
  }),
  'rows.resume': def({
    name: 'rows.resume',
    kind: 'write',
    description: 'Resume paused rows.',
    input: z.object({ collection: collectionArg, rows: z.array(rowIdSchema).min(1) }),
    output: z.object({ rows: z.array(rowSchema), ...cursorOut }),
  }),
  'rows.duplicate': def({
    name: 'rows.duplicate',
    kind: 'write',
    description: 'Duplicate a row directly below the original.',
    input: z.object({ collection: collectionArg, row: rowIdSchema }),
    output: z.object({ row: rowSchema, ...cursorOut }),
  }),

  'cells.get': def({
    name: 'cells.get',
    kind: 'read',
    images: true,
    description: 'Get a cell: current generation and its version history.',
    input: z.object({ cell: cellAddressSchema.describe('collection/row/column') }),
    output: z.object({
      cell: cellViewSchema,
      current: generationSchema.optional(),
      versions: z.array(generationSummarySchema),
      ...cursorOut,
    }),
  }),
  'cells.regenerate': def({
    name: 'cells.regenerate',
    kind: 'write',
    description: '"Give me another one": queue a new generation of the same request (forced).',
    input: z.object({ cell: cellAddressSchema.describe('collection/row/column') }),
    output: z.object({ generation: generationSchema, ...cursorOut }),
  }),
  'cells.retry': def({
    name: 'cells.retry',
    kind: 'write',
    description: 'Retry a failed, unsupported, or needs_attention cell with a fresh generation.',
    input: z.object({ cell: cellAddressSchema.describe('collection/row/column') }),
    output: z.object({ generation: generationSchema, ...cursorOut }),
  }),
  'cells.cancel': def({
    name: 'cells.cancel',
    kind: 'write',
    description: 'Cancel the in-flight generation of a cell, if any.',
    input: z.object({ cell: cellAddressSchema.describe('collection/row/column') }),
    output: z.object({ generation: generationSchema.optional(), ...cursorOut }),
  }),

  'generations.get': def({
    name: 'generations.get',
    kind: 'read',
    images: true,
    description: 'Get a generation with its full request snapshot, error, and timing.',
    input: z.object({ generation: generationRefSchema.describe('Generation id or collection/row/column#version') }),
    output: z.object({ generation: generationSchema }),
  }),

  'assets.upload': def({
    name: 'assets.upload',
    kind: 'write',
    description: 'Upload an image from base64 bytes, a local path, or a URL. Returns the asset id to use as a row input.',
    input: z
      .object({
        bytes: z.string().optional().describe('Base64-encoded file contents'),
        path: z.string().optional().describe('Local file path readable by the server'),
        url: z.string().url().optional().describe('URL to fetch'),
        mime: z.string().optional(),
        label: z.string().optional(),
      })
      .refine((v) => [v.bytes, v.path, v.url].filter((x) => x !== undefined).length === 1, {
        message: 'provide exactly one of bytes, path, url',
      }),
    output: z.object({ asset: assetViewSchema }),
  }),
  'assets.get': def({
    name: 'assets.get',
    kind: 'read',
    images: true,
    description: 'Get asset metadata (and the image itself over MCP).',
    input: z.object({ asset: assetIdSchema }),
    output: z.object({ asset: assetViewSchema }),
  }),
  'assets.list': def({
    name: 'assets.list',
    kind: 'read',
    description: 'List assets, newest first.',
    input: z.object({
      origin: z.enum(['upload', 'generation']).optional(),
      label: z.string().optional().describe('Substring match'),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    output: z.object({ assets: z.array(assetViewSchema), total: z.number().int() }),
  }),
  'assets.label': def({
    name: 'assets.label',
    kind: 'write',
    description: 'Set or clear an asset label.',
    input: z.object({ asset: assetIdSchema, label: z.string().nullable() }),
    output: z.object({ asset: assetViewSchema }),
  }),
  'assets.gc': def({
    name: 'assets.gc',
    kind: 'write',
    description: 'Delete assets referenced by no row input and no generation output, plus orphan files.',
    input: z.object({ dryRun: z.boolean().optional() }),
    output: z.object({ removed: z.array(assetIdSchema), orphanFiles: z.number().int(), dryRun: z.boolean() }),
  }),
} as const;

export type CommandDefs = typeof commandDefs;
export type CommandName = keyof CommandDefs;
export type CommandInput<N extends CommandName> = z.input<CommandDefs[N]['input']>;
export type CommandParsedInput<N extends CommandName> = z.output<CommandDefs[N]['input']>;
export type CommandOutput<N extends CommandName> = z.output<CommandDefs[N]['output']>;

export const commandNames = Object.keys(commandDefs) as CommandName[];

export function commandDef<N extends CommandName>(name: N): CommandDefs[N] {
  return commandDefs[name];
}

/** Asset URL conventions shared by server and clients. */
export function assetUrl(id: string): string {
  return `/assets/${id}`;
}
/** Bumped when thumbnail rendering changes; thumbs are cached immutably, so the URL must change. */
export const THUMB_VERSION = 2;
export function assetThumbUrl(id: string): string {
  return `/assets/${id}/thumb?v=${THUMB_VERSION}`;
}
