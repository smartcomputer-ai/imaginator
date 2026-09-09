import type { Asset, Column, CommonSettingsLike, Row, ResolvedRequest } from './resolve-types.js';
import { stableStringify, type JsonObject } from './json.js';
import { sha256Hex } from './sha256.js';
import { COMMON_KEYS, canonicalRatio, commonSettingsSchema, type CommonKey, type CommonSettings } from './settings.js';
import type { ModelRegistry } from './registry.js';
import type { ModelSpec } from './provider.js';
import type { AssetId } from './ids.js';

export interface ResolveContext {
  registry: ModelRegistry;
  /** Lookup for input asset metadata; `undefined` = missing asset. */
  asset(id: AssetId): Asset | undefined;
}

export interface ResolveResult {
  /** Identity of what was asked. Stable across registry and server upgrades. */
  hash: string;
  /** Snapshot to persist on the generation. Present even when unsupported. */
  request: ResolvedRequest;
  /** Empty when the cell can run; otherwise the reasons it is `unsupported`. */
  unsupported: string[];
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
): JsonObject {
  const { common } = mergeCommonSettings(collection.defaults, row.settings, spec);
  return {
    model: column.model,
    columnSettings: (column.settings ?? {}) as JsonObject,
    count: column.count,
    prompt: row.prompt,
    negativePrompt: row.negativePrompt ?? null,
    inputs: row.inputs.map((i) => ({ asset: i.asset, role: i.role, maskFor: i.maskFor ?? null })),
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
): string {
  return hashContent(cellContent(collection, row, column, spec));
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
  const hash = cellHash(collection, row, column, spec);
  const { common, dropped } = mergeCommonSettings(collection.defaults, row.settings, spec);
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
    inputs: row.inputs.map((i) => ({ asset: i.asset, role: i.role, ...(i.maskFor !== undefined ? { maskFor: i.maskFor } : {}) })),
    count: column.count,
    common,
    settings,
    droppedKeys: dropped,
    registryVersion: ctx.registry.version,
  };

  if (!spec) {
    return { hash, request, unsupported: [`unknown model ${column.model}`] };
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
    const asset = ctx.asset(input.asset);
    if (!asset) missing.push(input.asset);
    else inputAssets.push(asset);
  }
  if (row.inputs.length > caps.maxInputImages) {
    unsupported.push(`${row.inputs.length} inputs exceed the model maximum of ${caps.maxInputImages}`);
  }
  if (missing.length > 0) unsupported.push(`input asset(s) not found: ${missing.join(', ')}`);

  if (unsupported.length === 0) {
    unsupported.push(...spec.validateRequest(request, inputAssets));
  }

  return { hash, request, unsupported: dedupe(unsupported) };
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}
