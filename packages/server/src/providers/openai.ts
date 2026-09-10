import { z } from 'zod';
import {
  ProviderError,
  canonicalRatio,
  parseAspectRatio,
  parseSize,
  type Asset,
  type GenerateContext,
  type GenerateResult,
  type JsonValue,
  type ModelSpec,
  type OutputDescriptor,
  type Provider,
  type ResolvedRequest,
} from '@imaginator/core';
import { HttpError, fetchWithRetry } from './http.js';

/**
 * OpenAI Images API (`/v1/images/generations` and `/v1/images/edits`).
 *
 * The API is synchronous: one POST returns the finished images as base64, so
 * there is no job handle, no `resume`, and no `cancel` beyond aborting the
 * request. The submission POST is never retried here; the runner retries
 * errors this adapter marks retryable (429, 5xx, connection failures).
 */

export interface OpenAIOptions {
  apiKey: string;
  /** Default per-provider concurrency; config may override. */
  concurrency?: number;
  /** Override for proxies/tests. Default `https://api.openai.com/v1`. */
  baseUrl?: string;
  /** Per-request timeout; `max` quality on large sizes can take minutes. */
  timeoutMs?: number;
}

export const OPENAI_PROVIDER_ID = 'openai';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
/** Images per edit request, excluding the mask. */
const MAX_INPUT_IMAGES = 16;
const MAX_PROMPT_CHARS = 32_000;
const MAX_COUNT = 10;

/** Custom size rules for models that accept arbitrary `WIDTHxHEIGHT`. */
const SIZE_STEP = 16;
const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;
const MAX_EDGE = 3840;
const MAX_RATIO = 3;
/** Documented preset sizes, and the only sizes the older models accept. */
const PRESET_SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;
const PRESET_BY_RATIO: Record<string, string> = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' };
const OUTPUT_FORMATS = ['png', 'jpeg', 'webp'] as const;

// ---------------------------------------------------------------------------
// Model table
// ---------------------------------------------------------------------------

export interface OpenAIModelDef {
  /** API model name; aliases follow OpenAI's default snapshot. */
  slug: string;
  name: string;
  description: string;
  qualities: readonly [string, ...string[]];
  /** Arbitrary `WIDTHxHEIGHT` sizes (multiples of 16, 1:3..3:1) vs presets only. */
  customSizes: boolean;
  /** USD per million tokens, from the pricing page; used for the cost estimate. */
  price: { textIn: number; imageIn: number; imageOut: number };
}

const BASE_QUALITIES = ['auto', 'low', 'medium', 'high'] as const;
const EXTENDED_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const OPENAI_MODELS: readonly OpenAIModelDef[] = [
  {
    slug: 'gpt-image-2.5-sunburst',
    name: 'GPT Image 2.5 Sunburst',
    description: 'ChatGPT Images 2.5 tuned for editing precision and reference fidelity. Custom sizes, quality up to max.',
    qualities: EXTENDED_QUALITIES,
    customSizes: true,
    price: { textIn: 5, imageIn: 8, imageOut: 30 },
  },
  {
    slug: 'gpt-image-2.5-flare',
    name: 'GPT Image 2.5 Flare',
    description: 'ChatGPT Images 2.5 tuned for fast everyday generation; GPT Image 2 quality at up to half the latency.',
    qualities: EXTENDED_QUALITIES,
    customSizes: true,
    price: { textIn: 5, imageIn: 8, imageOut: 30 },
  },
  {
    slug: 'gpt-image-2',
    name: 'GPT Image 2',
    description: 'April 2026 model with a reasoning stage. Custom sizes; quality low/medium/high.',
    qualities: BASE_QUALITIES,
    customSizes: true,
    price: { textIn: 5, imageIn: 8, imageOut: 30 },
  },
  {
    slug: 'gpt-image-1.5',
    name: 'GPT Image 1.5',
    description: 'December 2025 model. Preset sizes only (1024x1024, 1536x1024, 1024x1536).',
    qualities: BASE_QUALITIES,
    customSizes: false,
    price: { textIn: 5, imageIn: 8, imageOut: 32 },
  },
  {
    slug: 'gpt-image-1',
    name: 'GPT Image 1',
    description: 'Original GPT Image model. Preset sizes only.',
    qualities: BASE_QUALITIES,
    customSizes: false,
    price: { textIn: 5, imageIn: 10, imageOut: 40 },
  },
  {
    slug: 'gpt-image-1-mini',
    name: 'GPT Image 1 Mini',
    description: 'Cheapest GPT Image model. Preset sizes only.',
    qualities: BASE_QUALITIES,
    customSizes: false,
    price: { textIn: 2, imageIn: 2.5, imageOut: 8 },
  },
];

export function modelIdFor(def: OpenAIModelDef): string {
  return `${OPENAI_PROVIDER_ID}/${def.slug}`;
}

const defsById = new Map(OPENAI_MODELS.map((d) => [modelIdFor(d), d]));

// ---------------------------------------------------------------------------
// Settings (column-owned, model-specific)
// ---------------------------------------------------------------------------

function settingsFor(def: OpenAIModelDef) {
  return z.object({
    quality: z.enum(def.qualities).default('auto').describe('Rendering quality; higher is slower and costs more output tokens'),
    background: z.enum(['auto', 'opaque', 'transparent']).default('auto').describe('Transparent requires png or webp output'),
    moderation: z.enum(['auto', 'low']).default('auto').describe('Content moderation strictness'),
    outputCompression: z.number().int().min(0).max(100).optional().describe('Compression level for jpeg/webp output (0-100); ignored for png'),
    inputFidelity: z.enum(['low', 'high']).optional().describe('How closely edits preserve the input images; only sent when the row has inputs'),
  });
}

type OpenAISettings = z.infer<ReturnType<typeof settingsFor>>;

function settingsOf(req: ResolvedRequest): OpenAISettings {
  const s = req.settings as Record<string, unknown>;
  return {
    quality: typeof s.quality === 'string' ? s.quality : 'auto',
    background: (s.background as OpenAISettings['background']) ?? 'auto',
    moderation: (s.moderation as OpenAISettings['moderation']) ?? 'auto',
    ...(typeof s.outputCompression === 'number' ? { outputCompression: s.outputCompression } : {}),
    ...(s.inputFidelity === 'low' || s.inputFidelity === 'high' ? { inputFidelity: s.inputFidelity } : {}),
  };
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/**
 * Pick a custom `WIDTHxHEIGHT` for an aspect ratio: about one megapixel,
 * multiples of 16, within the API's 1:3..3:1 bounds. Undefined when the ratio
 * cannot be honored.
 */
export function sizeForRatio(aspectRatio: string): string | undefined {
  const canonical = canonicalRatio(aspectRatio);
  if (canonical && PRESET_BY_RATIO[canonical]) return PRESET_BY_RATIO[canonical];
  const parsed = parseAspectRatio(aspectRatio);
  if (!parsed) return undefined;
  const [w, h] = parsed;
  const ratio = w / h;
  if (ratio > MAX_RATIO || ratio < 1 / MAX_RATIO) return undefined;
  const area = 1024 * 1024;
  let width = Math.round(Math.sqrt(area * ratio) / SIZE_STEP) * SIZE_STEP;
  let height = Math.round(width / ratio / SIZE_STEP) * SIZE_STEP;
  while (width * height < MIN_PIXELS) {
    width += SIZE_STEP;
    height = Math.round(width / ratio / SIZE_STEP) * SIZE_STEP;
  }
  const size = `${width}x${height}`;
  return validateCustomSize(size) === undefined ? size : undefined;
}

/** Error message for a custom size the API would reject, or undefined when fine. */
export function validateCustomSize(size: string): string | undefined {
  const parsed = parseSize(size);
  if (!parsed) return `size ${size} must look like 1024x1024`;
  const { width, height } = parsed;
  if (width % SIZE_STEP !== 0 || height % SIZE_STEP !== 0) return `size ${size}: width and height must be multiples of ${SIZE_STEP}`;
  if (width > MAX_EDGE || height > MAX_EDGE) return `size ${size}: no edge may exceed ${MAX_EDGE}px`;
  const pixels = width * height;
  if (pixels < MIN_PIXELS || pixels > MAX_PIXELS) return `size ${size}: total pixels must be between ${MIN_PIXELS} and ${MAX_PIXELS}`;
  if (width > MAX_RATIO * height || height > MAX_RATIO * width) return `size ${size}: aspect ratio must be between 1:${MAX_RATIO} and ${MAX_RATIO}:1`;
  return undefined;
}

/** The `size` parameter to send: explicit size, size derived from aspect ratio, or `auto`. */
export function sizeForRequest(req: ResolvedRequest, def: OpenAIModelDef): string {
  if (req.common.size) return req.common.size;
  if (req.common.aspectRatio) {
    const canonical = canonicalRatio(req.common.aspectRatio);
    const preset = canonical ? PRESET_BY_RATIO[canonical] : undefined;
    if (preset) return preset;
    if (def.customSizes) {
      const custom = sizeForRatio(req.common.aspectRatio);
      if (custom) return custom;
    }
  }
  return 'auto';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateRequestFor(def: OpenAIModelDef, req: ResolvedRequest, inputs: Asset[]): string[] {
  const errors: string[] = [];
  const settings = settingsOf(req);

  if (req.prompt.trim() === '') errors.push('prompt is empty');
  if (req.prompt.length > MAX_PROMPT_CHARS) errors.push(`prompt exceeds ${MAX_PROMPT_CHARS} characters`);

  if (req.common.size !== undefined && def.customSizes) {
    const err = validateCustomSize(req.common.size);
    if (err) errors.push(err);
  }
  if (req.common.size === undefined && req.common.aspectRatio !== undefined && sizeForRequest(req, def) === 'auto') {
    errors.push(
      def.customSizes
        ? `aspectRatio ${req.common.aspectRatio} cannot be honored (must be between 1:${MAX_RATIO} and ${MAX_RATIO}:1)`
        : `aspectRatio ${req.common.aspectRatio} not supported (allowed: ${Object.keys(PRESET_BY_RATIO).join(', ')})`,
    );
  }
  if (settings.background === 'transparent' && req.common.outputFormat === 'jpeg') {
    errors.push('transparent background requires png or webp output');
  }

  const images = req.inputs.filter((i) => i.role !== 'mask');
  const masks = req.inputs.filter((i) => i.role === 'mask');
  if (images.length > MAX_INPUT_IMAGES) errors.push(`${images.length} input images exceed the maximum of ${MAX_INPUT_IMAGES}`);
  if (masks.length > 1) errors.push('at most one mask; the API applies a mask to the first image only');

  req.inputs.forEach((input, i) => {
    const asset = inputs[i];
    if (!asset) return;
    if (asset.kind !== 'image' || !(IMAGE_MIMES as readonly string[]).includes(asset.mime)) {
      errors.push(`input ${asset.id} is ${asset.mime}; OpenAI accepts png, jpeg, webp`);
    }
    if (asset.bytes > MAX_INPUT_BYTES) errors.push(`input ${asset.id} exceeds 50MB`);
    if (input.role === 'mask') {
      if (asset.mime !== 'image/png') errors.push(`mask ${asset.id} must be a png with an alpha channel`);
      const target = inputs[input.maskFor!];
      if (target && (target.width !== asset.width || target.height !== asset.height)) {
        errors.push(`mask ${asset.id} (${asset.width}x${asset.height}) must match its init image ${target.id} (${target.width}x${target.height})`);
      }
    }
  });
  return errors;
}

function specFor(def: OpenAIModelDef): ModelSpec {
  return {
    id: modelIdFor(def),
    name: def.name,
    kind: 'image',
    description: def.description,
    capabilities: {
      inputRoles: ['init', 'mask', 'reference'],
      // 16 images plus one mask; the precise split is checked in validateRequest.
      maxInputImages: MAX_INPUT_IMAGES + 1,
      negativePrompt: false,
      commonKeys: ['size', 'aspectRatio', 'outputFormat'],
      count: MAX_COUNT,
      outputFormats: [...OUTPUT_FORMATS],
      ...(def.customSizes ? {} : { sizes: [...PRESET_SIZES], aspectRatios: Object.keys(PRESET_BY_RATIO) }),
    },
    settings: settingsFor(def),
    pricing: describePricing(def.price),
    validateRequest: (req, inputs) => validateRequestFor(def, req, inputs),
  };
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

export interface OpenAIImageParams {
  model: string;
  prompt: string;
  n: number;
  size: string;
  quality: string;
  background?: string;
  output_format?: string;
  output_compression?: number;
  moderation?: string;
  input_fidelity?: string;
}

/** Parameters shared by both endpoints. `input_fidelity` only when editing. */
export function buildParams(req: ResolvedRequest, def: OpenAIModelDef): OpenAIImageParams {
  const s = settingsOf(req);
  const format = req.common.outputFormat;
  const editing = req.inputs.length > 0;
  return {
    model: def.slug,
    prompt: req.prompt,
    n: req.count,
    size: sizeForRequest(req, def),
    quality: s.quality,
    ...(s.background !== 'auto' ? { background: s.background } : {}),
    ...(format ? { output_format: format } : {}),
    ...(s.outputCompression !== undefined && (format === 'jpeg' || format === 'webp') ? { output_compression: s.outputCompression } : {}),
    ...(s.moderation !== 'auto' ? { moderation: s.moderation } : {}),
    ...(editing && s.inputFidelity ? { input_fidelity: s.inputFidelity } : {}),
  };
}

/**
 * Input images in the order the API expects: the masked init image first
 * (the API applies `mask` to the first image), then the rest in row order.
 * Masks are excluded; the single mask is returned separately.
 */
export function orderInputs(req: ResolvedRequest): { images: ResolvedRequest['inputs']; mask: ResolvedRequest['inputs'][number] | undefined } {
  const mask = req.inputs.find((i) => i.role === 'mask');
  const target = mask ? req.inputs[mask.maskFor!] : undefined;
  const images = req.inputs.filter((i) => i.role !== 'mask' && i !== target);
  return { images: target ? [target, ...images] : images, mask };
}

const usageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    input_tokens_details: z.object({ text_tokens: z.number().optional(), image_tokens: z.number().optional() }).loose().optional(),
    output_tokens_details: z.object({ text_tokens: z.number().optional(), image_tokens: z.number().optional() }).loose().optional(),
  })
  .loose();
type Usage = z.infer<typeof usageSchema>;

const responseSchema = z
  .object({
    created: z.number().optional(),
    data: z.array(z.object({ b64_json: z.string().optional(), url: z.string().optional(), revised_prompt: z.string().optional() }).loose()),
    background: z.string().optional(),
    output_format: z.string().optional(),
    quality: z.string().optional(),
    size: z.string().optional(),
    usage: usageSchema.optional(),
  })
  .loose();

/** Output image tokens for a 1024x1024 image at medium and high quality (OpenAI's published token table). */
const REFERENCE_IMAGE_TOKENS = { medium: 1056, high: 4160 } as const;

/** One-line price for model pickers: the token rate plus what a square image costs at medium and high quality. */
export function describePricing(price: OpenAIModelDef['price']): string {
  const per = (tokens: number) => `$${((tokens * price.imageOut) / 1_000_000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${price.imageOut} per 1M output tokens (about ${per(REFERENCE_IMAGE_TOKENS.medium)} to ${per(REFERENCE_IMAGE_TOKENS.high)} per 1024x1024 image, medium to high); cost is computed from reported usage`;
}

/** USD estimate from token usage at the model's list prices. */
export function estimateCost(usage: Usage | undefined, price: OpenAIModelDef['price']): number | undefined {
  if (!usage) return undefined;
  const textIn = usage.input_tokens_details?.text_tokens ?? usage.input_tokens ?? 0;
  const imageIn = usage.input_tokens_details?.image_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  if (textIn === 0 && imageIn === 0 && out === 0) return undefined;
  const usd = (textIn * price.textIn + imageIn * price.imageIn + out * price.imageOut) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const NON_RETRYABLE_429 = new Set(['insufficient_quota', 'billing_hard_limit_reached']);
const MODERATION_CODES = new Set(['moderation_blocked', 'content_policy_violation', 'safety_violation']);

function parseErrorBody(text: string): { message?: string; code?: string; type?: string } {
  try {
    const json = JSON.parse(text) as { error?: { message?: unknown; code?: unknown; type?: unknown } };
    const e = json?.error ?? {};
    return {
      message: typeof e.message === 'string' ? e.message : undefined,
      code: typeof e.code === 'string' ? e.code : undefined,
      type: typeof e.type === 'string' ? e.type : undefined,
    };
  } catch {
    return {};
  }
}

/** Map an HTTP or transport failure of the submission POST to a ProviderError. */
export function toOpenAIError(e: unknown, timeoutMs: number): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof HttpError) {
    const body = parseErrorBody(e.bodyText);
    const detail = body.message ?? e.bodyText.slice(0, 300) ?? '';
    const message = `openai: HTTP ${e.status}${detail ? `: ${detail}` : ''}`;
    if (e.status === 401 || e.status === 403) return new ProviderError(message, { retryable: false, code: 'auth', cause: e });
    if (e.status === 429) {
      const quota = body.code !== undefined && NON_RETRYABLE_429.has(body.code);
      return new ProviderError(message, { retryable: !quota, code: quota ? body.code : 'rate_limited', cause: e });
    }
    if (e.status >= 500) return new ProviderError(message, { retryable: true, code: `http_${e.status}`, cause: e });
    if (body.code !== undefined && MODERATION_CODES.has(body.code)) {
      return new ProviderError(message, { retryable: false, code: 'moderation_blocked', cause: e });
    }
    return new ProviderError(message, { retryable: false, code: body.code ?? `http_${e.status}`, cause: e });
  }
  const msg = (e as Error)?.message ?? String(e);
  if (/timeout/i.test(msg)) {
    return new ProviderError(`openai: no response within ${Math.round(timeoutMs / 1000)}s; the request may still have been billed`, {
      retryable: false,
      code: 'timeout',
      cause: e,
    });
  }
  return new ProviderError(`openai: request failed: ${msg}`, { retryable: true, code: 'network', cause: e });
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const EXT_BY_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function createOpenAIProvider(opts: OpenAIOptions): Provider {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authHeaders = { Authorization: `Bearer ${opts.apiKey}` };

  async function submit(url: string, init: { headers: Record<string, string>; body: RequestInit['body'] }, ctx: GenerateContext): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchWithRetry(url, { method: 'POST', headers: { ...authHeaders, ...init.headers }, body: init.body, timeoutMs, signal: ctx.signal });
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? e;
      throw toOpenAIError(e, timeoutMs);
    }
    try {
      return await res.json();
    } catch (e) {
      throw new ProviderError('openai: response was not JSON', { retryable: false, code: 'bad_response', cause: e });
    }
  }

  return {
    id: OPENAI_PROVIDER_ID,
    name: 'OpenAI',
    concurrency: opts.concurrency ?? 4,
    models: OPENAI_MODELS.map(specFor),

    async generate(req, ctx) {
      const def = defsById.get(req.model);
      if (!def) throw new ProviderError(`unknown openai model ${req.model}`, { kind: 'unsupported' });
      const params = buildParams(req, def);
      const { images, mask } = orderInputs(req);

      let raw: unknown;
      if (images.length === 0 && !mask) {
        ctx.log(`openai: generations ${def.slug} n=${params.n} size=${params.size} quality=${params.quality}`);
        raw = await submit(`${baseUrl}/images/generations`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) }, ctx);
      } else {
        const form = new FormData();
        for (const [key, value] of Object.entries(params)) form.append(key, String(value));
        for (const input of images) {
          const a = await ctx.asset(input.asset);
          form.append('image[]', new Blob([new Uint8Array(a.bytes)], { type: a.mime }), `${input.asset}.${EXT_BY_MIME[a.mime] ?? 'bin'}`);
        }
        if (mask) {
          const a = await ctx.asset(mask.asset);
          form.append('mask', new Blob([new Uint8Array(a.bytes)], { type: a.mime }), `${mask.asset}.png`);
        }
        ctx.log(`openai: edits ${def.slug} images=${images.length}${mask ? ' +mask' : ''} n=${params.n} size=${params.size} quality=${params.quality}`);
        raw = await submit(`${baseUrl}/images/edits`, { headers: {}, body: form }, ctx);
      }

      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderError(`openai: unexpected response shape: ${parsed.error.issues[0]?.message ?? 'invalid'}`, { retryable: false, code: 'bad_response' });
      const body = parsed.data;
      const format = body.output_format ?? params.output_format ?? 'png';
      const mime = `image/${format}`;
      const outputs: OutputDescriptor[] = [];
      for (const item of body.data) {
        if (item.b64_json) {
          outputs.push({ bytes: new Uint8Array(Buffer.from(item.b64_json, 'base64')), mime, ...(item.revised_prompt ? { meta: { revisedPrompt: item.revised_prompt } } : {}) });
        } else if (item.url) {
          outputs.push({ url: item.url, mime, ...(item.revised_prompt ? { meta: { revisedPrompt: item.revised_prompt } } : {}) });
        }
      }
      if (outputs.length === 0) throw new ProviderError('openai: response contained no images', { retryable: false, code: 'no_output' });

      const providerMeta: JsonValue = {
        model: def.slug,
        endpoint: images.length === 0 && !mask ? 'generations' : 'edits',
        size: body.size ?? params.size,
        quality: body.quality ?? params.quality,
        background: body.background ?? null,
        outputFormat: format,
        created: body.created ?? null,
        usage: (body.usage as JsonValue | undefined) ?? null,
      };
      const cost = estimateCost(body.usage, def.price);
      return { outputs, ...(cost !== undefined ? { cost } : {}), providerMeta };
    },
  };
}
