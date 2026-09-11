import type { Asset, Column, CommonSettingsLike, Row, ResolvedRequest } from './resolve-types.js';
import { isRef, type AssetInput, type GenerationStatus, type Input } from './domain.js';
import { stableStringify, type JsonObject } from './json.js';
import { sha256Hex } from './sha256.js';
import { COMMON_KEYS, canonicalRatio, commonSettingsSchema, type CommonKey, type CommonSettings } from './settings.js';
import type { ModelRegistry } from './registry.js';
import type { ModelSpec } from './provider.js';
import { cellKeyOf, formatCellLabel, type AssetId, type CellAddress, type ColumnId, type RowId } from './ids.js';

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_TEMPLATE = '{prompt}';
export const DEFAULT_NEGATIVE_TEMPLATE = '{negativePrompt}';

/** Render a column template against a row. Only `{prompt}` and `{negativePrompt}` are substituted. */
export function renderTemplate(template: string, row: { prompt: string; negativePrompt?: string }): string {
  return template.replaceAll('{prompt}', row.prompt).replaceAll('{negativePrompt}', row.negativePrompt ?? '');
}

/** The prompt and negative prompt a cell asks for, after the column recipe. */
export function renderPrompts(row: Row, column: Column): { prompt: string; negativePrompt: string | undefined } {
  const prompt = renderTemplate(column.prompt ?? DEFAULT_PROMPT_TEMPLATE, row);
  const negative = renderTemplate(column.negativePrompt ?? DEFAULT_NEGATIVE_TEMPLATE, row);
  return { prompt, negativePrompt: negative === '' ? undefined : negative };
}

// ---------------------------------------------------------------------------
// Inputs and references
// ---------------------------------------------------------------------------

export interface GridLike {
  slug: string;
  status?: 'live' | 'paused';
  defaults: CommonSettingsLike;
  rows: Row[];
  columns: Column[];
}

/** What a reference resolves to: the source cell's current outputs, or why it cannot yet. */
export type Upstream = { outputs: AssetId[] } | { blocked: string; pending: boolean };
/** `origin` is the cell being resolved; reasons are phrased relative to it. */
export type UpstreamLookup = (target: CellAddress, origin: CellAddress) => Upstream;

export interface ResolveContext {
  registry: ModelRegistry;
  /** Lookup for input asset metadata; `undefined` = missing asset. */
  asset(id: AssetId): Asset | undefined;
  /** Current outputs of other cells, for references. Absent = every reference is blocked. */
  upstream?: UpstreamLookup;
}

export interface ResolveResult {
  /** Identity of what was asked. Stable across registry and server upgrades. */
  hash: string;
  /** Snapshot to persist on the generation. Present even when unsupported. */
  request: ResolvedRequest;
  /** Empty when the cell can run; otherwise the reasons it is `unsupported`. */
  unsupported: string[];
  /**
   * Set when a reference has no usable output yet and the cell would
   * otherwise be runnable. A blocked cell has no desired generation: nothing
   * is inserted and `hash` matches nothing. A cell that is unsupported on its
   * own terms (too many inputs, a role the model rejects, ...) reports that
   * instead, since no source could make it run.
   */
  blocked?: string;
  /** With `blocked`: whether the source is expected to produce output on its own. */
  pending?: boolean;
  /** The row does not run in this column (sparse row). */
  skipped?: boolean;
  /** Cells this cell reads from, after anchors are filled in. */
  precedents: CellAddress[];
}

/** The concrete cell a reference points at, from where it is written. */
export function referenceTarget(input: { row?: RowId; column?: ColumnId; collection?: string }, origin: CellAddress): CellAddress {
  return { collection: input.collection ?? origin.collection, row: input.row ?? origin.row, column: input.column ?? origin.column };
}

/** The input list a cell uses: the column's replacement list, or the row's. */
export function effectiveInputs(row: Row, column: Column): { inputs: Input[]; placement: 'row' | 'column' } {
  return column.inputs ? { inputs: column.inputs, placement: 'column' } : { inputs: row.inputs, placement: 'row' };
}

/** Concrete precedents of a cell, without resolving anything. */
export function cellPrecedents(slug: string, row: Row, column: Column): CellAddress[] {
  const origin = { collection: slug, row: row.id, column: column.id };
  const out: CellAddress[] = [];
  const seen = new Set<string>();
  for (const input of effectiveInputs(row, column).inputs) {
    if (!isRef(input)) continue;
    const t = referenceTarget(input, origin);
    const k = cellKeyOf(t);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/** Resolve a cell's inputs: references become asset inputs, or a reason they cannot. */
export function resolveInputs(
  slug: string,
  row: Row,
  column: Column,
  upstream: UpstreamLookup | undefined,
): { inputs: AssetInput[]; content: JsonObject[]; blocked: string[]; pending: boolean; precedents: CellAddress[] } {
  const origin: CellAddress = { collection: slug, row: row.id, column: column.id };
  const inputs: AssetInput[] = [];
  const content: JsonObject[] = [];
  const blocked: string[] = [];
  const precedents: CellAddress[] = [];
  let pending = false;
  for (const input of effectiveInputs(row, column).inputs) {
    const rest = { role: input.role, ...(input.maskFor !== undefined ? { maskFor: input.maskFor } : {}) };
    let asset: AssetId | undefined;
    if (!isRef(input)) {
      asset = input.asset;
    } else {
      const target = referenceTarget(input, origin);
      precedents.push(target);
      const label = formatCellLabel(target, origin);
      const up = upstream ? upstream(target, origin) : { blocked: `waiting for ${label}`, pending: true };
      if ('blocked' in up) {
        blocked.push(up.blocked);
        pending ||= up.pending;
      } else if (up.outputs[input.output ?? 0] === undefined) {
        blocked.push(`${label} has no output #${input.output ?? 0}`);
      } else {
        asset = up.outputs[input.output ?? 0];
      }
      if (asset === undefined) {
        // Placeholder so a blocked cell's hash never matches a real generation.
        content.push({ ref: cellKeyOf(target), output: input.output ?? 0, role: input.role, maskFor: input.maskFor ?? null });
        continue;
      }
    }
    inputs.push({ asset, ...rest });
    content.push({ asset, role: input.role, maskFor: input.maskFor ?? null });
  }
  return { inputs, content, blocked: dedupe(blocked), pending, precedents };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Merge collection defaults with row settings, then drop keys the model does
 * not honor. Returns the kept settings and the list of dropped keys.
 */
export function mergeCommonSettings(
  defaults: CommonSettingsLike,
  rowSettings: CommonSettingsLike | undefined,
  spec: ModelSpec | undefined,
): { common: CommonSettings; dropped: CommonKey[] } {
  const merged: Record<string, unknown> = { ...defaults, ...(rowSettings ?? {}) };
  const common: Record<string, unknown> = {};
  const dropped: CommonKey[] = [];
  for (const key of COMMON_KEYS) {
    const value = merged[key];
    if (value === undefined) continue;
    if (spec && !spec.capabilities.commonKeys.includes(key)) {
      dropped.push(key);
    } else {
      common[key] = value;
    }
  }
  return { common: common as CommonSettings, dropped };
}

// ---------------------------------------------------------------------------
// Content and hash
// ---------------------------------------------------------------------------

/**
 * `content()` from DESIGN §4.1: what the cell asks for, with unhonored common
 * keys removed. Templates and references are hashed by what they resolve to.
 */
export function cellContent(collection: GridLike, row: Row, column: Column, spec: ModelSpec | undefined, upstream?: UpstreamLookup): JsonObject {
  return contentWithInputs(collection, row, column, spec, resolveInputs(collection.slug, row, column, upstream).content);
}

function contentWithInputs(collection: GridLike, row: Row, column: Column, spec: ModelSpec | undefined, inputs: JsonObject[]): JsonObject {
  const { common } = mergeCommonSettings(collection.defaults, row.settings, spec);
  const prompts = renderPrompts(row, column);
  return {
    model: column.model,
    columnSettings: (column.settings ?? {}) as JsonObject,
    count: column.count,
    prompt: prompts.prompt,
    negativePrompt: prompts.negativePrompt ?? null,
    inputs,
    common: common as JsonObject,
  };
}

export function hashContent(content: JsonObject): string {
  return sha256Hex(stableStringify(content));
}

export function cellHash(collection: GridLike, row: Row, column: Column, spec: ModelSpec | undefined, upstream?: UpstreamLookup): string {
  return hashContent(cellContent(collection, row, column, spec, upstream));
}

export function isSkipped(row: Row, column: Column): boolean {
  return row.columns !== undefined && !row.columns.includes(column.id);
}

/**
 * Resolve a cell into a request snapshot plus its hash, and decide whether the
 * (row, column) pair is supported by the column's model. Pure.
 */
export function resolveCell(collection: GridLike, row: Row, column: Column, ctx: ResolveContext): ResolveResult {
  const spec = ctx.registry.get(column.model);
  const resolvedInputs = resolveInputs(collection.slug, row, column, ctx.upstream);
  const hash = hashContent(contentWithInputs(collection, row, column, spec, resolvedInputs.content));
  const { common, dropped } = mergeCommonSettings(collection.defaults, row.settings, spec);
  const prompts = renderPrompts(row, column);
  const skipped = isSkipped(row, column) ? { skipped: true as const } : {};
  const blocked = resolvedInputs.blocked.length > 0 ? { blocked: resolvedInputs.blocked.join('; '), pending: resolvedInputs.pending } : {};
  const unsupported: string[] = [];

  // Column settings: fill registry defaults, validate against the model schema.
  let settings: JsonObject = (column.settings ?? {}) as JsonObject;
  if (spec) {
    const parsed = spec.settings.strict().safeParse(column.settings ?? {});
    if (parsed.success) {
      settings = parsed.data as JsonObject;
    } else {
      for (const issue of parsed.error.issues) {
        unsupported.push(`settings.${issue.path.join('.') || '?'}: ${issue.message}`);
      }
    }
  }

  const request: ResolvedRequest = {
    model: column.model,
    prompt: prompts.prompt,
    ...(prompts.negativePrompt !== undefined ? { negativePrompt: prompts.negativePrompt } : {}),
    inputs: resolvedInputs.inputs,
    count: column.count,
    common,
    settings,
    droppedKeys: dropped,
    registryVersion: ctx.registry.version,
  };
  const precedents = resolvedInputs.precedents;

  if (!spec) {
    return { hash, request, unsupported: [`unknown model ${column.model}`], precedents, ...blocked, ...skipped };
  }
  const caps = spec.capabilities;

  const commonCheck = commonSettingsSchema.safeParse(common);
  if (!commonCheck.success) {
    for (const issue of commonCheck.error.issues) unsupported.push(`${issue.path.join('.')}: ${issue.message}`);
  }
  if (common.aspectRatio !== undefined && caps.aspectRatios && !caps.aspectRatios.includes(common.aspectRatio)) {
    unsupported.push(`aspectRatio ${common.aspectRatio} not supported (allowed: ${caps.aspectRatios.join(', ')})`);
  }
  if (common.size !== undefined && caps.sizes && !caps.sizes.includes(common.size)) {
    unsupported.push(`size ${common.size} not supported (allowed: ${caps.sizes.join(', ')})`);
  }
  if (common.outputFormat !== undefined && caps.outputFormats && !caps.outputFormats.includes(common.outputFormat)) {
    unsupported.push(`outputFormat ${common.outputFormat} not supported (allowed: ${caps.outputFormats.join(', ')})`);
  }
  if (common.size !== undefined && common.aspectRatio !== undefined) {
    const a = canonicalRatio(common.size);
    const b = canonicalRatio(common.aspectRatio);
    if (a !== b) unsupported.push(`size ${common.size} and aspectRatio ${common.aspectRatio} disagree`);
  }

  if (column.count > caps.count) {
    unsupported.push(`count ${column.count} exceeds the model maximum of ${caps.count}`);
  }
  if (prompts.negativePrompt !== undefined && !caps.negativePrompt) {
    unsupported.push('model does not support a negative prompt');
  }

  const effective = effectiveInputs(row, column).inputs;
  for (const input of effective) {
    if (!caps.inputRoles.includes(input.role)) {
      unsupported.push(
        caps.inputRoles.length === 0
          ? `model is text-only and cannot take a ${input.role} input`
          : `model does not accept ${input.role} inputs (accepts: ${caps.inputRoles.join(', ')})`,
      );
    }
  }
  const inputAssets: Asset[] = [];
  const missing: string[] = [];
  for (const input of resolvedInputs.inputs) {
    const asset = ctx.asset(input.asset);
    if (!asset) missing.push(input.asset);
    else inputAssets.push(asset);
  }
  if (effective.length > caps.maxInputImages) {
    unsupported.push(`${effective.length} inputs exceed the model maximum of ${caps.maxInputImages}`);
  }
  const min = caps.minInputImages ?? 0;
  const images = effective.filter((i) => i.role !== 'mask').length;
  if (min > 0 && images < min) {
    unsupported.push(min === 1 ? 'model requires an input image (an edit-only model): add a reference or a frozen asset' : `model requires at least ${min} input images`);
  }
  if (missing.length > 0) unsupported.push(`input asset(s) not found: ${missing.join(', ')}`);

  if (unsupported.length === 0 && resolvedInputs.blocked.length === 0) {
    unsupported.push(...spec.validateRequest(request, inputAssets));
  }

  // Unsupported on its own terms beats blocked: the reason the user can act on is the structural one.
  return { hash, request, unsupported: dedupe(unsupported), precedents, ...(unsupported.length === 0 ? blocked : {}), ...skipped };
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

// ---------------------------------------------------------------------------
// Workbook resolution: cells across collections, in dependency order
// ---------------------------------------------------------------------------

/** What the resolver needs to know about a source cell for a given desired hash. */
export interface CellState {
  /** Outputs of the current *success* (pinned, else newest succeeded) with this hash. */
  outputs?: AssetId[];
  /** Status of the newest non-cancelled attempt with this hash, if any. */
  latestStatus?: GenerationStatus;
  /** Its error message, when it has one (surfaced in dependents' blocked reasons). */
  latestError?: string;
  /** An explicit cancellation hold applies to this hash. */
  held?: boolean;
}

export interface WorkbookContext {
  registry: ModelRegistry;
  asset(id: AssetId): Asset | undefined;
  /** Load a collection by slug; `undefined` when it does not exist. Called lazily, memoized by the resolver. */
  grid(slug: string): GridLike | undefined;
  /** The state of a cell for exactly this desired hash. */
  cell(target: CellAddress, hash: string): CellState;
}

export interface WorkbookResolver {
  /** Resolve a cell; `undefined` when the collection, row, or column does not exist. */
  resolve(target: CellAddress): ResolveResult | undefined;
  grid(slug: string): GridLike | undefined;
}

/**
 * Resolve any cell of any collection, following references to the source
 * cell's current success. Memoized; a reference cycle or unknown target
 * blocks instead of looping.
 */
export function createWorkbookResolver(ctx: WorkbookContext): WorkbookResolver {
  const grids = new Map<string, GridLike | undefined>();
  const memo = new Map<string, ResolveResult | undefined>();
  const visiting = new Set<string>();

  const grid = (slug: string): GridLike | undefined => {
    if (!grids.has(slug)) grids.set(slug, ctx.grid(slug));
    return grids.get(slug);
  };

  const upstream: UpstreamLookup = (target, origin) => {
    const label = formatCellLabel(target, origin);
    const g = grid(target.collection);
    if (!g) return { blocked: `collection ${target.collection} not found`, pending: false };
    const row = g.rows.find((r) => r.id === target.row);
    const column = g.columns.find((c) => c.id === target.column);
    if (!row || !column) return { blocked: `${label} not found`, pending: false };
    if (visiting.has(cellKeyOf(target))) return { blocked: `${label} references itself (cycle)`, pending: false };
    const resolved = resolve(target)!;
    if (resolved.skipped) return { blocked: `${label} is skipped`, pending: false };
    if (resolved.blocked) return { blocked: `${label}: ${resolved.blocked}`, pending: resolved.pending ?? false };
    const state = ctx.cell(target, resolved.hash);
    if (state.outputs) return { outputs: state.outputs };
    // The source's own reason lives on the source; here it is enough to point at it.
    switch (state.latestStatus) {
      case 'failed':
      case 'unsupported':
      case 'needs_attention':
        return { blocked: `${label} cannot produce an output (${state.latestStatus.replace('_', ' ')}); see that cell`, pending: false };
      case 'queued':
      case 'submitting':
      case 'running':
      case 'downloading':
        return { blocked: `waiting for ${label}`, pending: true };
      default:
        break;
    }
    if (resolved.unsupported.length > 0) return { blocked: `${label} cannot produce an output (unsupported); see that cell`, pending: false };
    if (state.held) return { blocked: `${label} was cancelled`, pending: false };
    if (g.status === 'paused' || row.paused) return { blocked: `${label} is paused and needs generation`, pending: false };
    return { blocked: `waiting for ${label}`, pending: true };
  };

  function resolve(target: CellAddress): ResolveResult | undefined {
    const key = cellKeyOf(target);
    if (memo.has(key)) return memo.get(key);
    const g = grid(target.collection);
    const row = g?.rows.find((r) => r.id === target.row);
    const column = g?.columns.find((c) => c.id === target.column);
    if (!g || !row || !column) {
      memo.set(key, undefined);
      return undefined;
    }
    visiting.add(key);
    try {
      const result = resolveCell(g, row, column, { registry: ctx.registry, asset: ctx.asset, upstream });
      memo.set(key, result);
      return result;
    } finally {
      visiting.delete(key);
    }
  }

  return { resolve, grid };
}

/** Row ids referenced by a row's inputs (deduplicated); same-collection references only. */
export function referencedRows(inputs: Input[]): RowId[] {
  return dedupe(inputs.flatMap((i) => (isRef(i) && i.row !== undefined && i.collection === undefined ? [i.row] : [])));
}
