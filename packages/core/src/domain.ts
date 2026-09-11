import { z } from 'zod';
import {
  assetIdSchema,
  collectionSlugSchema,
  columnIdSchema,
  generationIdSchema,
  modelIdSchema,
  parseReference,
  rowIdSchema,
} from './ids.js';
import { jsonObjectSchema, jsonValueSchema } from './json.js';
import { commonKeySchema, commonSettingsSchema, modelSettingsSchema } from './settings.js';

export const isoDateSchema = z.string();

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const INPUT_ROLES = ['reference', 'init', 'mask'] as const;
export const inputRoleSchema = z.enum(INPUT_ROLES);
export type InputRole = (typeof INPUT_ROLES)[number];

const inputBase = {
  role: inputRoleSchema,
  /** For `mask` inputs: zero-based index of the `init` input it masks. */
  maskFor: z.number().int().min(0).optional(),
};

function checkMask(v: { role: InputRole; maskFor?: number }, ctx: z.RefinementCtx): void {
  if (v.role === 'mask' && v.maskFor === undefined) {
    ctx.addIssue({ code: 'custom', message: 'a mask input must set maskFor (index of its init target)' });
  }
  if (v.role !== 'mask' && v.maskFor !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'only mask inputs may set maskFor' });
  }
}

/** A frozen image: an uploaded or previously generated asset. */
export const assetInputSchema = z.object({ asset: assetIdSchema, ...inputBase }).superRefine(checkMask);
export type AssetInput = z.infer<typeof assetInputSchema>;

/**
 * A live reference to another cell's current output (DESIGN §3, References).
 * Anchors left out are filled from the cell being resolved: on a row, `row`
 * is required and `column` defaults to the same column; on a column,
 * `column` is required and `row` defaults to the same row. `collection`
 * requires both. `output` indexes the source cell's outputs (default 0).
 */
export const refInputSchema = z
  .object({
    row: rowIdSchema.optional(),
    column: columnIdSchema.optional(),
    collection: collectionSlugSchema.optional(),
    output: z.number().int().min(0).optional(),
    ...inputBase,
  })
  .superRefine((v, ctx) => {
    checkMask(v, ctx);
    if (v.row === undefined && v.column === undefined) ctx.addIssue({ code: 'custom', message: 'a reference needs a row, a column, or both' });
    if (v.collection !== undefined && (v.row === undefined || v.column === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'a reference into another collection must be a full address (collection, row, column)' });
    }
  });
export type RefInput = z.infer<typeof refInputSchema>;

/** `{ ref: 'r3/flux', role }`: the string form of a reference, normalized to `RefInput`. */
const refStringInputSchema = z
  .object({ ref: z.string(), output: z.number().int().min(0).optional(), ...inputBase })
  .transform(({ ref, ...rest }, ctx) => {
    try {
      const anchors = parseReference(ref);
      return { ...anchors, ...rest } as RefInput;
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: (e as Error).message });
      return z.NEVER;
    }
  })
  .pipe(refInputSchema);

export const inputSchema = z.union([assetInputSchema, refInputSchema, refStringInputSchema]);
export type Input = AssetInput | RefInput;

export function isRef(input: Input): input is RefInput {
  return !('asset' in input);
}

function checkMaskTargets(inputs: Input[], ctx: z.RefinementCtx): void {
  inputs.forEach((input, i) => {
    if (input.role !== 'mask') return;
    const target = inputs[input.maskFor!];
    if (!target) {
      ctx.addIssue({ code: 'custom', path: [i, 'maskFor'], message: `maskFor ${input.maskFor} points at no input` });
    } else if (target.role !== 'init') {
      ctx.addIssue({ code: 'custom', path: [i, 'maskFor'], message: `maskFor ${input.maskFor} must point at an init input` });
    }
  });
}

/** Inputs written on a row: every reference names a row. */
export const rowInputsSchema = z.array(inputSchema).superRefine((inputs, ctx) => {
  checkMaskTargets(inputs, ctx);
  inputs.forEach((input, i) => {
    if (isRef(input) && input.row === undefined) ctx.addIssue({ code: 'custom', path: [i], message: 'a reference on a row must name a row (r3 or r3/column)' });
  });
});

/** Inputs written on a column recipe: every reference names a column. */
export const columnInputsSchema = z.array(inputSchema).superRefine((inputs, ctx) => {
  checkMaskTargets(inputs, ctx);
  inputs.forEach((input, i) => {
    if (isRef(input) && input.column === undefined) ctx.addIssue({ code: 'custom', path: [i], message: 'a reference on a column must name a column (flux or r3/flux)' });
  });
});

/** @deprecated use rowInputsSchema */
export const inputsSchema = rowInputsSchema;

// ---------------------------------------------------------------------------
// Columns, rows, collections
// ---------------------------------------------------------------------------

export const columnSchema = z.object({
  id: columnIdSchema,
  model: modelIdSchema,
  settings: modelSettingsSchema.optional(),
  /** Outputs per cell; capped by the model's `capabilities.count`. */
  count: z.number().int().min(1),
  position: z.number().int().min(0),
  /** Recipe: prompt template, default `{prompt}`. */
  prompt: z.string().optional(),
  /** Recipe: negative prompt template, default `{negativePrompt}`; '' drops it. */
  negativePrompt: z.string().optional(),
  /** Recipe: absent inherits the row's inputs; present replaces them. */
  inputs: columnInputsSchema.optional(),
});
export type Column = z.infer<typeof columnSchema>;

export const rowSchema = z.object({
  id: rowIdSchema,
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  inputs: rowInputsSchema,
  settings: commonSettingsSchema.optional(),
  /** Sparse row: run only in these columns; absent = every column. */
  columns: z.array(columnIdSchema).optional(),
  paused: z.boolean(),
  position: z.number().int().min(0),
  notes: z.string().optional(),
});
export type Row = z.infer<typeof rowSchema>;

export const COLLECTION_STATUSES = ['live', 'paused'] as const;
export const collectionStatusSchema = z.enum(COLLECTION_STATUSES);
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

export const collectionSchema = z.object({
  slug: collectionSlugSchema,
  title: z.string(),
  description: z.string().optional(),
  status: collectionStatusSchema,
  defaults: commonSettingsSchema,
  columns: z.array(columnSchema),
  rows: z.array(rowSchema),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Collection = z.infer<typeof collectionSchema>;

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const ASSET_KINDS = ['image', 'video'] as const;
export const assetKindSchema = z.enum(ASSET_KINDS);
export type AssetKind = (typeof ASSET_KINDS)[number];

export const assetOriginSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('upload') }),
  z.object({ type: z.literal('generation'), generation: generationIdSchema }),
]);
export type AssetOrigin = z.infer<typeof assetOriginSchema>;

export const assetSchema = z.object({
  id: assetIdSchema,
  kind: assetKindSchema,
  origin: assetOriginSchema,
  mime: z.string(),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  bytes: z.number().int().min(0),
  sha256: z.string(),
  label: z.string().optional(),
  createdAt: isoDateSchema,
});
export type Asset = z.infer<typeof assetSchema>;

// ---------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------

export const GENERATION_STATUSES = [
  'queued',
  'submitting',
  'running',
  'downloading',
  'succeeded',
  'failed',
  'cancelled',
  'unsupported',
  'needs_attention',
] as const;
export const generationStatusSchema = z.enum(GENERATION_STATUSES);
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

/** Statuses in which the runner still owns the generation. */
export const ACTIVE_STATUSES: readonly GenerationStatus[] = ['queued', 'submitting', 'running', 'downloading'];
/** Terminal statuses that still satisfy a cell (no automatic rerun). */
export const TERMINAL_STATUSES: readonly GenerationStatus[] = ['succeeded', 'failed', 'unsupported', 'needs_attention'];

export function isActiveStatus(s: GenerationStatus): boolean {
  return ACTIVE_STATUSES.includes(s);
}

export const generationErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  retryable: z.boolean(),
});
export type GenerationError = z.infer<typeof generationErrorSchema>;

/** Adapter-owned, versioned, persisted handle. Never contains API keys. */
export const providerRefSchema = z.object({
  version: z.number().int(),
  model: modelIdSchema,
  data: jsonObjectSchema,
});
export type ProviderRef = z.infer<typeof providerRefSchema>;

export const remoteOutputSchema = z.object({
  url: z.string(),
  mime: z.string().optional(),
  meta: jsonValueSchema.optional(),
});
export type RemoteOutput = z.infer<typeof remoteOutputSchema>;

export const stagedOutputSchema = z.object({
  stagedPath: z.string(),
  mime: z.string(),
  meta: jsonValueSchema.optional(),
});
export type StagedOutput = z.infer<typeof stagedOutputSchema>;

export const pendingOutputSchema = z.union([remoteOutputSchema, stagedOutputSchema]);
export type PendingOutput = z.infer<typeof pendingOutputSchema>;

/**
 * The resolved application request: what `resolve()` produced from the
 * collection content plus registry defaults. Immutable once the generation is
 * inserted. `requestHash` is NOT a hash of this object (see DESIGN §4.1).
 */
export const resolvedRequestSchema = z.object({
  model: modelIdSchema,
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  /** Always asset inputs: row references are resolved to the upstream cell's output. */
  inputs: z.array(assetInputSchema),
  count: z.number().int().min(1),
  /** Common settings after defaults and after dropping unsupported keys. */
  common: commonSettingsSchema,
  /** Column model settings with registry defaults filled in. */
  settings: jsonObjectSchema,
  /** Common keys that were set but are not honored by the model. */
  droppedKeys: z.array(commonKeySchema),
  registryVersion: z.string(),
});
export type ResolvedRequest = z.infer<typeof resolvedRequestSchema>;

export const generationTimingSchema = z.object({
  queuedAt: isoDateSchema,
  startedAt: isoDateSchema.optional(),
  finishedAt: isoDateSchema.optional(),
});
export type GenerationTiming = z.infer<typeof generationTimingSchema>;

export const generationSchema = z.object({
  id: generationIdSchema,
  collection: collectionSlugSchema,
  row: rowIdSchema,
  column: columnIdSchema,
  version: z.number().int().min(1),
  requestHash: z.string(),
  request: resolvedRequestSchema,
  status: generationStatusSchema,
  providerRef: providerRefSchema.optional(),
  pendingOutputs: z.array(pendingOutputSchema).optional(),
  outputs: z.array(assetIdSchema),
  error: generationErrorSchema.optional(),
  attempt: z.number().int().min(1),
  forced: z.boolean(),
  timing: generationTimingSchema,
  cost: z.number().optional(),
  providerMeta: jsonValueSchema.optional(),
});
export type Generation = z.infer<typeof generationSchema>;
