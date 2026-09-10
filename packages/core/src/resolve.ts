import type { Asset, Column, CommonSettingsLike, Row, ResolvedRequest } from './resolve-types.js';
import { isRowRef, type AssetInput, type GenerationStatus, type Input } from './domain.js';
import { stableStringify, type JsonObject } from './json.js';
import { sha256Hex } from './sha256.js';
import { COMMON_KEYS, canonicalRatio, commonSettingsSchema, type CommonKey, type CommonSettings } from './settings.js';
import type { ModelRegistry } from './registry.js';
import type { ModelSpec } from './provider.js';
import type { AssetId, ColumnId, RowId } from './ids.js';

/** What a row reference resolves to: the upstream cell's current outputs, or why it cannot yet. */
export type Upstream = { outputs: AssetId[] } | { blocked: string };
export type UpstreamLookup = (row: RowId, column: ColumnId) => Upstream;

export interface ResolveContext {
  registry: ModelRegistry;
  /** Lookup for input asset metadata; `undefined` = missing asset. */
  asset(id: AssetId): Asset | undefined;
  /**
   * Current outputs of another cell in the same collection, for row-reference
   * inputs. Absent = every row reference is blocked.
   */
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
   * Set when a row-reference input has no output yet (upstream missing, in
   * flight, failed, ...). A blocked cell has no desired generation: nothing is
   * inserted and `hash` matches nothing. The text says what it waits for.
   */
  blocked?: string;
}

/** Resolve a row's inputs: row references become asset inputs, or a reason they cannot. */
export function resolveInputs(
  row: Row,
  column: Column,
  upstream: UpstreamLookup | undefined,
): { inputs: AssetInput[]; content: JsonObject[]; blocked: string[] } {
  const inputs: AssetInput[] = [];
  const content: JsonObject[] = [];
  const blocked: string[] = [];
  for (const input of row.inputs) {
    const rest = { role: input.role, ...(input.maskFor !== undefined ? { maskFor: input.maskFor } : {}) };
    let asset: AssetId | undefined;
    if (!isRowRef(input)) {
      asset = input.asset;
    } else {
      const up = upstream ? upstream(input.row, column.id) : { blocked: `waiting for ${input.row}` };
      if ('blocked' in up) {
        blocked.push(up.blocked);
      } else if (up.outputs[input.output ?? 0] === undefined) {
        blocked.push(`${input.row} has no output #${input.output ?? 0}`);
      } else {
        asset = up.outputs[input.output ?? 0];
      }
    }
    if (asset !== undefined) {
      inputs.push({ asset, ...rest });
      content.push({ asset, role: input.role, maskFor: input.maskFor ?? null });
    } else if (isRowRef(input)) {
      // Placeholder so a blocked cell's hash never matches a real generation.
      content.push({ ref: input.row, output: input.output ?? 0, role: input.role, maskFor: input.maskFor ?? null });
    }
  }
  return { inputs, content, blocked: dedupe(blocked) };
}

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

/**
 * `content()` from DESIGN §4.1: what the user wrote, with unhonored common
 * keys removed. Registry defaults and anything resolve() adds are excluded.
 */
export function cellContent(
  collection: { defaults: CommonSettingsLike },
  row: Row,
  column: Column,
  spec: ModelSpec | undefined,
  upstream?: UpstreamLookup,
): JsonObject {
  const { common } = mergeCommonSettings(collection.defaults, row.settings, spec);
  return {
    model: column.model,
    columnSettings: (column.settings ?? {}) as JsonObject,
    count: column.count,
    prompt: row.prompt,
    negativePrompt: row.negativePrompt ?? null,
    inputs: resolveInputs(row, column, upstream).content,
    common: common as JsonObject,
  };
}

export function hashContent(content: JsonObject): string {
  return sha256Hex(stableStringify(content));
}

export function cellHash(
  collection: { defaults: CommonSettingsLike },
  row: Row,
  column: Column,
  spec: ModelSpec | undefined,
  upstream?: UpstreamLookup,
): string {
  return hashContent(cellContent(collection, row, column, spec, upstream));
}

/**
 * Resolve a cell into a request snapshot plus its hash, and decide whether the
 * (row, column) pair is supported by the column's model. Pure.
 */
export function resolveCell(
  collection: { defaults: CommonSettingsLike },
  row: Row,
  column: Column,
  ctx: ResolveContext,
): ResolveResult {
  const spec = ctx.registry.get(column.model);
  const hash = cellHash(collection, row, column, spec, ctx.upstream);
  const { common, dropped } = mergeCommonSettings(collection.defaults, row.settings, spec);
  const resolvedInputs = resolveInputs(row, column, ctx.upstream);
  const blocked = resolvedInputs.blocked.length > 0 ? { blocked: resolvedInputs.blocked.join('; ') } : {};
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
    prompt: row.prompt,
    ...(row.negativePrompt !== undefined ? { negativePrompt: row.negativePrompt } : {}),
    inputs: resolvedInputs.inputs,
    count: column.count,
    common,
    settings,
    droppedKeys: dropped,
    registryVersion: ctx.registry.version,
  };

  if (!spec) {
    return { hash, request, unsupported: [`unknown model ${column.model}`], ...blocked };
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
  if (row.negativePrompt !== undefined && row.negativePrompt !== '' && !caps.negativePrompt) {
    unsupported.push('model does not support a negative prompt');
  }

  const inputAssets: Asset[] = [];
  const missing: string[] = [];
  for (const input of row.inputs) {
    if (!caps.inputRoles.includes(input.role)) {
      unsupported.push(
        caps.inputRoles.length === 0
          ? `model is text-only and cannot take a ${input.role} input`
          : `model does not accept ${input.role} inputs (accepts: ${caps.inputRoles.join(', ')})`,
      );
    }
  }
  for (const input of resolvedInputs.inputs) {
    const asset = ctx.asset(input.asset);
    if (!asset) missing.push(input.asset);
    else inputAssets.push(asset);
  }
  if (row.inputs.length > caps.maxInputImages) {
    unsupported.push(`${row.inputs.length} inputs exceed the model maximum of ${caps.maxInputImages}`);
  }
  if (missing.length > 0) unsupported.push(`input asset(s) not found: ${missing.join(', ')}`);

  if (unsupported.length === 0 && resolvedInputs.blocked.length === 0) {
    unsupported.push(...spec.validateRequest(request, inputAssets));
  }

  return { hash, request, unsupported: dedupe(unsupported), ...blocked };
}

// ---------------------------------------------------------------------------
// Grid resolution: cells in dependency order
// ---------------------------------------------------------------------------

export interface GridGeneration {
  status: GenerationStatus;
  outputs: AssetId[];
}

export interface GridResolveContext {
  registry: ModelRegistry;
  asset(id: AssetId): Asset | undefined;
  /** The newest non-cancelled generation of the cell with exactly this hash, if any. */
  generation(row: RowId, column: ColumnId, hash: string): GridGeneration | undefined;
}

export interface GridLike {
  defaults: CommonSettingsLike;
  rows: Row[];
  columns: Column[];
}

/**
 * Resolve every cell of a collection, following row references to the
 * upstream cell's *current* generation (newest non-cancelled with the desired
 * hash). Memoized; a reference cycle or unknown row blocks instead of looping.
 */
export function createGridResolver(collection: GridLike, ctx: GridResolveContext): (row: RowId, column: ColumnId) => ResolveResult {
  const rows = new Map(collection.rows.map((r) => [r.id, r]));
  const columns = new Map(collection.columns.map((c) => [c.id, c]));
  const memo = new Map<string, ResolveResult>();
  const visiting = new Set<string>();

  const upstream: UpstreamLookup = (rowId, columnId) => {
    const row = rows.get(rowId);
    if (!row) return { blocked: `row ${rowId} not found` };
    const key = `${rowId} ${columnId}`;
    if (visiting.has(key)) return { blocked: `${rowId} references itself` };
    const resolved = resolve(rowId, columnId);
    if (resolved.blocked) return { blocked: `${rowId}: ${resolved.blocked}` };
    const g = ctx.generation(rowId, columnId, resolved.hash);
    if (!g) return { blocked: `waiting for ${rowId}` };
    switch (g.status) {
      case 'succeeded':
        return { outputs: g.outputs };
      case 'failed':
        return { blocked: `${rowId} failed` };
      case 'unsupported':
        return { blocked: `${rowId} is unsupported` };
      case 'needs_attention':
        return { blocked: `${rowId} needs attention` };
      default:
        return { blocked: `waiting for ${rowId}` };
    }
  };

  function resolve(rowId: RowId, columnId: ColumnId): ResolveResult {
    const key = `${rowId} ${columnId}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const row = rows.get(rowId);
    const column = columns.get(columnId);
    if (!row || !column) throw new Error(`no cell ${rowId}/${columnId}`);
    visiting.add(key);
    try {
      const result = resolveCell(collection, row, column, { registry: ctx.registry, asset: ctx.asset, upstream });
      memo.set(key, result);
      return result;
    } finally {
      visiting.delete(key);
    }
  }

  return resolve;
}

/** Row ids referenced by a row's inputs (deduplicated). */
export function referencedRows(inputs: Input[]): RowId[] {
  return dedupe(inputs.filter(isRowRef).map((i) => i.row));
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}
