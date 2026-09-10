import type { z } from 'zod';
import type { Asset, AssetKind, InputRole, ProviderRef, RemoteOutput, ResolvedRequest } from './domain.js';
import type { AssetId, ModelId } from './ids.js';
import type { JsonValue } from './json.js';
import type { CommonKey } from './settings.js';

export interface ModelCapabilities {
  /** Empty = text-only. */
  inputRoles: InputRole[];
  maxInputImages: number;
  negativePrompt: boolean;
  commonKeys: CommonKey[];
  /** Max outputs per request. */
  count: number;
  aspectRatios?: string[];
  sizes?: string[];
  outputFormats?: string[];
}

export interface ModelSpec {
  /** `provider/model`, e.g. `bfl/flux-pro-1.1`. */
  id: ModelId;
  name: string;
  kind: AssetKind;
  capabilities: ModelCapabilities;
  /**
   * Pure validation beyond capabilities: role combinations, per-role counts,
   * mask/target compatibility, input MIME/byte/dimension limits. `inputs`
   * matches `req.inputs` in order. Returns human-readable errors; empty = ok.
   */
  validateRequest(req: ResolvedRequest, inputs: Asset[]): string[];
  /** Model-specific keys; defaults declared here fill gaps at resolve time. */
  settings: z.ZodObject<z.ZodRawShape>;
  /** Per-model default concurrency, overriding the provider's. */
  concurrency?: number;
  /** Optional free-text description shown in model pickers. */
  description?: string;
  /** One-line, human-readable price ("$0.04 per image", "$0.012 per megapixel"). Estimates only; see each adapter. */
  pricing?: string;
}

export interface GenerateContext {
  signal: AbortSignal;
  asset(id: AssetId): Promise<{ bytes: Uint8Array; mime: string; path: string }>;
  /** Commit the durable handle and move to `running` before any monitoring. */
  setProviderRef(ref: ProviderRef): Promise<void>;
  /** Abortable sleep. */
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export type InlineOutput = { bytes: Uint8Array; mime: string; meta?: JsonValue };
export type OutputDescriptor = RemoteOutput | InlineOutput;

export function isRemoteOutput(o: OutputDescriptor): o is RemoteOutput {
  return typeof (o as RemoteOutput).url === 'string';
}

export interface GenerateResult {
  outputs: OutputDescriptor[];
  cost?: number;
  providerMeta?: JsonValue;
}

export type CancelOutcome = 'confirmed' | 'pending' | 'unsupported';

export interface Provider {
  /** 'openai', 'bfl', 'fal', 'google', 'replicate', 'mock'. */
  id: string;
  name?: string;
  models: ModelSpec[];
  /** Default per-provider concurrency; config may override. */
  concurrency?: number;
  generate(req: ResolvedRequest, ctx: GenerateContext): Promise<GenerateResult>;
  resume?(providerRef: ProviderRef, ctx: GenerateContext): Promise<GenerateResult>;
  cancel?(providerRef: ProviderRef): Promise<CancelOutcome>;
}

/**
 * Errors adapters throw to classify a failure. Anything else thrown is
 * treated as `{ kind: 'failed', retryable: false }`.
 */
export class ProviderError extends Error {
  readonly kind: 'failed' | 'ambiguous' | 'unsupported';
  readonly retryable: boolean;
  readonly code: string | undefined;
  constructor(
    message: string,
    opts: { kind?: 'failed' | 'ambiguous' | 'unsupported'; retryable?: boolean; code?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ProviderError';
    this.kind = opts.kind ?? 'failed';
    this.retryable = opts.retryable ?? false;
    this.code = opts.code;
  }
}

export function providerIdOf(modelId: ModelId): string {
  return modelId.slice(0, modelId.indexOf('/'));
}
