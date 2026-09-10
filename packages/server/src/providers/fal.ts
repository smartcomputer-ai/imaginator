import sharp from 'sharp';
import { z } from 'zod';
import {
  ProviderError,
  canonicalRatio,
  parseAspectRatio,
  parseSize,
  type Asset,
  type CancelOutcome,
  type CommonKey,
  type GenerateContext,
  type GenerateResult,
  type InputRole,
  type JsonObject,
  type JsonValue,
  type ModelSpec,
  type OutputDescriptor,
  type Provider,
  type ProviderRef,
  type ResolvedRequest,
} from '@imaginator/core';
import { HttpError, fetchJson, fetchWithRetry, isRetryableStatus } from './http.js';

/**
 * fal.ai queue API. One adapter, many models: each entry in the model table
 * maps our request onto one fal endpoint's input schema.
 *
 * Lifecycle: POST `queue.fal.run/<endpoint>` → `{ request_id, status_url,
 * response_url, cancel_url }`; the handle is committed via `setProviderRef`
 * before polling `status_url` (IN_QUEUE → IN_PROGRESS → COMPLETED) and
 * fetching `response_url`. Cancel is `PUT cancel_url`. Input images are
 * uploaded to fal storage first because fal cannot fetch localhost URLs.
 * Outputs come back as public URLs the runner downloads.
 */

export interface FalOptions {
  apiKey: string;
  concurrency?: number;
  /** Queue base; default `https://queue.fal.run`. */
  queueUrl?: string;
  /** REST base for storage uploads; default `https://rest.fal.ai`. */
  restUrl?: string;
  /** Poll interval while IN_QUEUE / IN_PROGRESS. */
  pollMs?: number;
  /** Give up monitoring after this long (the remote request keeps its handle). */
  maxWaitMs?: number;
  /** Per-call HTTP timeout. */
  timeoutMs?: number;
}

export const FAL_PROVIDER_ID = 'fal';
const DEFAULT_QUEUE_URL = 'https://queue.fal.run';
const DEFAULT_REST_URL = 'https://rest.fal.ai';
const DEFAULT_POLL_MS = 1500;
const DEFAULT_MAX_WAIT_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 60_000;
const REF_VERSION = 1;

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;

// ---------------------------------------------------------------------------
// Model table
// ---------------------------------------------------------------------------

/** The six presets every `image_size` endpoint accepts, keyed by canonical ratio. */
const SIZE_PRESETS: Record<string, string> = {
  '1:1': 'square_hd',
  '4:3': 'landscape_4_3',
  '16:9': 'landscape_16_9',
  '3:4': 'portrait_4_3',
  '9:16': 'portrait_16_9',
};

/** How a fal endpoint takes its output dimensions. */
type SizeMode =
  /** `image_size`: preset name or `{ width, height }`. */
  | { kind: 'image_size'; custom: { min: number; max: number; step?: number }; default?: string }
  /** `aspect_ratio` enum only; optional `resolution` enum. */
  | { kind: 'aspect_ratio'; ratios: readonly string[]; default?: string; resolutions?: readonly string[] };

type ImageInputMode =
  /** No image inputs. */
  | { kind: 'none' }
  /** One `image_url` (reference or init). */
  | { kind: 'single'; field: string; max: 1 }
  /** `image_urls: string[]`. */
  | { kind: 'multi'; field: string; max: number };

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * fal publishes one list price per endpoint; the response carries no usage or
 * charge, so cost is estimated from the price and what we know about the
 * request. A "megapixel" is 1024x1024 px (fal bills a 1024x1024 image as one),
 * rounded up per image.
 */
export type FalPricing =
  /** Flat rate per output image. */
  | { kind: 'per_image'; usd: number }
  /** Per output megapixel, rounded up per image. */
  | { kind: 'per_megapixel'; usd: number }
  /** Flat rate per image chosen by one settings value (resolution tier, rendering speed), plus optional flat surcharges. */
  | { kind: 'per_image_by_setting'; setting: string; usd: Record<string, number>; default: string; surcharges?: { setting: string; value: string; usd: number }[] }
  /** FLUX.2 pro: one rate for the first output megapixel, another for every extra megapixel of input and output. */
  | { kind: 'flux2_pro'; firstMegapixel: number; extraMegapixel: number };

export const MEGAPIXEL = 1024 * 1024;

const FLUX2_PRO_PRICING: FalPricing = { kind: 'flux2_pro', firstMegapixel: 0.03, extraMegapixel: 0.015 };

export interface FalCostInput {
  /** Resolved model settings (registry defaults filled in). */
  settings: Record<string, unknown>;
  /** Pixel count of each output image; undefined when unknown. */
  outputPixels: (number | undefined)[];
  /** Pixel counts of the input images, when known (only some prices need them). */
  inputPixels?: number[];
}

function megapixels(pixels: number): number {
  return Math.max(1, Math.ceil(pixels / MEGAPIXEL));
}

function roundUsd(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** USD estimate for one fal request, or undefined when something the price depends on is unknown. */
export function estimateFalCost(pricing: FalPricing, input: FalCostInput): number | undefined {
  const n = input.outputPixels.length;
  if (n === 0) return undefined;
  switch (pricing.kind) {
    case 'per_image':
      return roundUsd(pricing.usd * n);
    case 'per_megapixel': {
      let mp = 0;
      for (const px of input.outputPixels) {
        if (px === undefined) return undefined;
        mp += megapixels(px);
      }
      return roundUsd(pricing.usd * mp);
    }
    case 'per_image_by_setting': {
      const raw = input.settings[pricing.setting];
      const key = typeof raw === 'string' ? raw : pricing.default;
      const perImage = pricing.usd[key] ?? pricing.usd[pricing.default];
      if (perImage === undefined) return undefined;
      let extra = 0;
      for (const s of pricing.surcharges ?? []) if (input.settings[s.setting] === s.value) extra += s.usd;
      return roundUsd((perImage + extra) * n);
    }
    case 'flux2_pro': {
      const inputs = input.inputPixels;
      if (inputs === undefined) return undefined;
      const inputPx = inputs.reduce((a, b) => a + b, 0);
      let usd = 0;
      for (const px of input.outputPixels) {
        if (px === undefined) return undefined;
        usd += pricing.firstMegapixel + pricing.extraMegapixel * (megapixels(px + inputPx) - 1);
      }
      return roundUsd(usd);
    }
  }
}

function fmtUsd(usd: number): string {
  return `$${usd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

/** One-line description of a price for model pickers. */
export function describeFalPricing(pricing: FalPricing): string {
  switch (pricing.kind) {
    case 'per_image':
      return `${fmtUsd(pricing.usd)} per image`;
    case 'per_megapixel':
      return `${fmtUsd(pricing.usd)} per megapixel`;
    case 'per_image_by_setting': {
      const tiers = Object.entries(pricing.usd).map(([k, v]) => `${k} ${fmtUsd(v)}`).join(', ');
      const extra = (pricing.surcharges ?? []).map((s) => `; +${fmtUsd(s.usd)} with ${s.setting} ${s.value}`).join('');
      return `per image by ${pricing.setting}: ${tiers}${extra}`;
    }
    case 'flux2_pro':
      return `${fmtUsd(pricing.firstMegapixel)} for the first output megapixel, ${fmtUsd(pricing.extraMegapixel)} per extra megapixel of input and output`;
  }
}

/** Output pixels implied by the `image_size` field we send, for endpoints that do not report dimensions. */
const PRESET_PIXELS: Record<string, number> = {
  square_hd: 1024 * 1024,
  square: 512 * 512,
  landscape_4_3: 1024 * 768,
  landscape_16_9: 1024 * 576,
  portrait_4_3: 768 * 1024,
  portrait_16_9: 576 * 1024,
};

export function requestedOutputPixels(fields: Record<string, JsonValue>): number | undefined {
  const size = fields.image_size;
  if (typeof size === 'string') return PRESET_PIXELS[size];
  if (size && typeof size === 'object' && !Array.isArray(size)) {
    const { width, height } = size as { width?: unknown; height?: unknown };
    if (typeof width === 'number' && typeof height === 'number') return width * height;
  }
  return undefined;
}

async function pixelsOf(bytes: Uint8Array): Promise<number | undefined> {
  try {
    const m = await sharp(bytes).metadata();
    return m.width && m.height ? m.width * m.height : undefined;
  } catch {
    return undefined;
  }
}

export interface FalModelDef {
  /** fal endpoint id, e.g. `fal-ai/flux-pro/v1.1-ultra`. Also our model slug. */
  endpoint: string;
  name: string;
  description: string;
  size: SizeMode;
  images: ImageInputMode;
  inputRoles: InputRole[];
  /** Max `num_images`; 1 when the endpoint has no such field. */
  maxImages: number;
  seed: boolean;
  negativePrompt: boolean;
  outputFormats?: readonly string[];
  /** Model-specific settings (column-owned). Keys are sent as-is unless mapped in `mapSettings`. */
  settings: z.ZodObject<z.ZodRawShape>;
  /** Optional per-model rewrite of settings into fal input fields. */
  mapSettings?: (settings: Record<string, unknown>, req: ResolvedRequest) => Record<string, JsonValue>;
  /** List price from the endpoint's fal page; the source of the per-generation cost estimate. */
  pricing: FalPricing;
  concurrency?: number;
}

const safetyTolerance6 = z.enum(['1', '2', '3', '4', '5', '6']);
const safetyTolerance5 = z.enum(['1', '2', '3', '4', '5']);
const acceleration = z.enum(['none', 'regular', 'high']);

const fluxProSettings = z.object({
  safety_tolerance: safetyTolerance6.default('2').describe('1 = strictest, 6 = most permissive'),
  enhance_prompt: z.boolean().default(false).describe('Let the model rewrite the prompt'),
});

const IMAGE_SIZE_PRESET_RATIOS = Object.keys(SIZE_PRESETS);

export const FAL_MODELS: readonly FalModelDef[] = [
  {
    endpoint: 'fal-ai/flux-pro/v1.1-ultra',
    name: 'FLUX 1.1 [pro] ultra',
    description: 'Black Forest Labs flagship at up to 2K. Aspect ratios 21:9 to 9:21; optional raw mode.',
    size: { kind: 'aspect_ratio', ratios: ['21:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '9:21'], default: '16:9' },
    images: { kind: 'single', field: 'image_url', max: 1 },
    inputRoles: ['reference'],
    maxImages: 4,
    seed: true,
    negativePrompt: false,
    outputFormats: ['jpeg', 'png'],
    settings: fluxProSettings.extend({
      raw: z.boolean().default(false).describe('Less processed, more natural-looking images'),
      image_prompt_strength: z.number().min(0).max(1).default(0.1).describe('Influence of the reference image'),
    }),
    pricing: { kind: 'per_image', usd: 0.06 },
  },
  {
    endpoint: 'fal-ai/flux-pro/v1.1',
    name: 'FLUX 1.1 [pro]',
    description: 'Black Forest Labs pro model; presets or custom sizes.',
    size: { kind: 'image_size', custom: { min: 256, max: 14142 }, default: 'landscape_4_3' },
    images: { kind: 'none' },
    inputRoles: [],
    maxImages: 4,
    seed: true,
    negativePrompt: false,
    outputFormats: ['jpeg', 'png'],
    settings: fluxProSettings,
    pricing: { kind: 'per_image', usd: 0.04 },
  },
  {
    endpoint: 'fal-ai/flux-pro/kontext/max',
    name: 'FLUX.1 Kontext [max]',
    description: 'Prompt-driven editing of one input image with strong preservation.',
    size: { kind: 'aspect_ratio', ratios: ['21:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '9:21'] },
    images: { kind: 'single', field: 'image_url', max: 1 },
    inputRoles: ['init', 'reference'],
    maxImages: 4,
    seed: true,
    negativePrompt: false,
    outputFormats: ['jpeg', 'png'],
    settings: fluxProSettings.extend({
      guidance_scale: z.number().min(1).max(20).default(3.5).describe('CFG scale'),
    }),
    pricing: { kind: 'per_image', usd: 0.08 },
  },
  {
    endpoint: 'fal-ai/flux-2-pro',
    name: 'FLUX.2 [pro]',
    description: 'FLUX.2 pro text-to-image. One image per request; custom sizes 256-2560 in steps of 16.',
    size: { kind: 'image_size', custom: { min: 256, max: 2560, step: 16 }, default: 'landscape_4_3' },
    images: { kind: 'none' },
    inputRoles: [],
    maxImages: 1,
    seed: true,
    negativePrompt: false,
    outputFormats: ['jpeg', 'png'],
    settings: z.object({
      safety_tolerance: safetyTolerance5.default('2').describe('1 = strictest, 5 = most permissive'),
      enable_safety_checker: z.boolean().default(true),
    }),
    pricing: FLUX2_PRO_PRICING,
  },
  {
    endpoint: 'fal-ai/flux-2-pro/edit',
    name: 'FLUX.2 [pro] edit',
    description: 'FLUX.2 pro multi-image editing. One image per request; size defaults to the inputs.',
    size: { kind: 'image_size', custom: { min: 256, max: 2560, step: 16 } },
    images: { kind: 'multi', field: 'image_urls', max: 10 },
    inputRoles: ['init', 'reference'],
    maxImages: 1,
    seed: true,
    negativePrompt: false,
    outputFormats: ['jpeg', 'png'],
    settings: z.object({
      safety_tolerance: safetyTolerance5.default('2').describe('1 = strictest, 5 = most permissive'),
      enable_safety_checker: z.boolean().default(true),
    }),
    pricing: FLUX2_PRO_PRICING,
  },
  {
    endpoint: 'fal-ai/flux-2',
    name: 'FLUX.2 [dev]',
    description: 'Open FLUX.2 weights hosted by fal; steps, guidance and acceleration are tunable.',
    size: { kind: 'image_size', custom: { min: 512, max: 2048 }, default: 'landscape_4_3' },
    images: { kind: 'none' },
    inputRoles: [],
    maxImages: 4,
    seed: true,
    negativePrompt: false,
    outputFormats: ['jpeg', 'png', 'webp'],
    settings: z.object({
      guidance_scale: z.number().min(0).max(20).default(2.5),
      num_inference_steps: z.number().int().min(4).max(50).default(28),
      acceleration: acceleration.default('regular'),
      enable_safety_checker: z.boolean().default(true),
      enable_prompt_expansion: z.boolean().default(false),
    }),
    pricing: { kind: 'per_megapixel', usd: 0.012 },
  },
  {
    endpoint: 'fal-ai/flux/dev',
    name: 'FLUX.1 [dev]',
    description: 'FLUX.1 dev, 28 steps by default.',
    size: { kind: 'image_size', custom: { min: 256, max: 14142 }, default: 'landscape_4_3' },
    images: { kind: 'none' },
    inputRoles: [],
    maxImages: 4,
    seed: true,
    negativePrompt: false,
    outputFormats: ['jpeg', 'png'],
    settings: z.object({
      guidance_scale: z.number().min(1).max(20).default(3.5),
      num_inference_steps: z.number().int().min(1).max(50).default(28),
      acceleration: acceleration.default('none'),
      enable_safety_checker: z.boolean().default(true),
    }),
    pricing: { kind: 'per_megapixel', usd: 0.025 },
  },
  {
    endpoint: 'fal-ai/flux/schnell',
    name: 'FLUX.1 [schnell]',
    description: 'Fastest FLUX; 1-12 steps, priced per megapixel.',
    size: { kind: 'image_size', custom: { min: 256, max: 14142 }, default: 'landscape_4_3' },
    images: { kind: 'none' },
    inputRoles: [],
    maxImages: 4,
    seed: true,
    negativePrompt: false,
    outputFormats: ['jpeg', 'png'],
    settings: z.object({
      num_inference_steps: z.number().int().min(1).max(12).default(4),
      guidance_scale: z.number().min(1).max(20).default(3.5),
      acceleration: acceleration.default('none'),
      enable_safety_checker: z.boolean().default(true),
    }),
    pricing: { kind: 'per_megapixel', usd: 0.003 },
  },
  {
    endpoint: 'fal-ai/nano-banana-2',
    name: 'Nano Banana 2',
    description: "Google's Gemini image model via fal. Aspect ratios up to 8:1, resolutions 0.5K-4K.",
    size: {
      kind: 'aspect_ratio',
      ratios: ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '4:1', '1:4', '8:1', '1:8'],
      resolutions: ['0.5K', '1K', '2K', '4K'],
    },
    images: { kind: 'none' },
    inputRoles: [],
    maxImages: 4,
    seed: true,
    negativePrompt: false,
    outputFormats: ['jpeg', 'png', 'webp'],
    settings: z.object({
      resolution: z.enum(['0.5K', '1K', '2K', '4K']).default('1K'),
      safety_tolerance: safetyTolerance6.default('4').describe('1 = strictest, 6 = most permissive'),
      thinking_level: z.enum(['minimal', 'high']).optional(),
      system_prompt: z.string().optional(),
    }),
    pricing: { kind: 'per_image_by_setting', setting: 'resolution', usd: { '0.5K': 0.06, '1K': 0.08, '2K': 0.12, '4K': 0.16 }, default: '1K', surcharges: [{ setting: 'thinking_level', value: 'high', usd: 0.002 }] },
  },
  {
    endpoint: 'fal-ai/nano-banana-2/edit',
    name: 'Nano Banana 2 edit',
    description: 'Nano Banana 2 with up to 10 input images as references or edit sources.',
    size: {
      kind: 'aspect_ratio',
      ratios: ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '4:1', '1:4', '8:1', '1:8'],
      resolutions: ['0.5K', '1K', '2K', '4K'],
    },
    images: { kind: 'multi', field: 'image_urls', max: 10 },
    inputRoles: ['init', 'reference'],
    maxImages: 4,
    seed: true,
    negativePrompt: false,
    outputFormats: ['jpeg', 'png', 'webp'],
    settings: z.object({
      resolution: z.enum(['0.5K', '1K', '2K', '4K']).default('1K'),
      safety_tolerance: safetyTolerance6.default('4').describe('1 = strictest, 6 = most permissive'),
      thinking_level: z.enum(['minimal', 'high']).optional(),
      system_prompt: z.string().optional(),
    }),
    pricing: { kind: 'per_image_by_setting', setting: 'resolution', usd: { '0.5K': 0.06, '1K': 0.08, '2K': 0.12, '4K': 0.16 }, default: '1K', surcharges: [{ setting: 'thinking_level', value: 'high', usd: 0.002 }] },
  },
  {
    endpoint: 'fal-ai/nano-banana-pro',
    name: 'Nano Banana Pro',
    description: 'Higher-quality Gemini image model via fal; 1K-4K.',
    size: { kind: 'aspect_ratio', ratios: ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'], default: '1:1', resolutions: ['1K', '2K', '4K'] },
    images: { kind: 'none' },
    inputRoles: [],
    maxImages: 4,
    seed: true,
    negativePrompt: false,
    outputFormats: ['jpeg', 'png', 'webp'],
    settings: z.object({
      resolution: z.enum(['1K', '2K', '4K']).default('1K'),
      safety_tolerance: safetyTolerance6.default('4').describe('1 = strictest, 6 = most permissive'),
      system_prompt: z.string().optional(),
    }),
    pricing: { kind: 'per_image_by_setting', setting: 'resolution', usd: { '1K': 0.15, '2K': 0.15, '4K': 0.3 }, default: '1K' },
  },
  {
    endpoint: 'fal-ai/ideogram/v3',
    name: 'Ideogram V3',
    description: 'Typography-strong model for posters and logos; style references via image inputs.',
    size: { kind: 'image_size', custom: { min: 256, max: 14142 }, default: 'square_hd' },
    images: { kind: 'multi', field: 'image_urls', max: 3 },
    inputRoles: ['reference'],
    maxImages: 8,
    seed: true,
    negativePrompt: true,
    settings: z.object({
      rendering_speed: z.enum(['TURBO', 'BALANCED', 'QUALITY']).default('BALANCED'),
      style: z.enum(['AUTO', 'GENERAL', 'REALISTIC', 'DESIGN']).optional(),
      expand_prompt: z.boolean().default(true).describe('Use MagicPrompt to expand the prompt'),
    }),
    pricing: { kind: 'per_image_by_setting', setting: 'rendering_speed', usd: { TURBO: 0.03, BALANCED: 0.06, QUALITY: 0.09 }, default: 'BALANCED' },
  },
  {
    endpoint: 'fal-ai/recraft/v3/text-to-image',
    name: 'Recraft V3',
    description: 'Design-oriented model with explicit styles; one image per request.',
    size: { kind: 'image_size', custom: { min: 256, max: 14142 }, default: 'square_hd' },
    images: { kind: 'none' },
    inputRoles: [],
    maxImages: 1,
    seed: false,
    negativePrompt: false,
    settings: z.object({
      style: z.string().default('realistic_image').describe('Recraft style id, e.g. realistic_image, digital_illustration, vector_illustration'),
      enable_safety_checker: z.boolean().default(false),
    }),
    pricing: { kind: 'per_image', usd: 0.04 },
  },
  {
    endpoint: 'fal-ai/recraft/v4/text-to-image',
    name: 'Recraft V4',
    description: 'Recraft V4 for brand-consistent assets; one image per request.',
    size: { kind: 'image_size', custom: { min: 256, max: 14142 }, default: 'square_hd' },
    images: { kind: 'none' },
    inputRoles: [],
    maxImages: 1,
    seed: false,
    negativePrompt: false,
    settings: z.object({
      enable_safety_checker: z.boolean().default(true),
    }),
    pricing: { kind: 'per_image', usd: 0.04 },
  },
  {
    endpoint: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
    name: 'Seedream 4.5',
    description: 'ByteDance Seedream 4.5; 2K by default, custom sizes 1920-4096.',
    size: { kind: 'image_size', custom: { min: 1920, max: 4096 } },
    images: { kind: 'none' },
    inputRoles: [],
    maxImages: 6,
    seed: true,
    negativePrompt: false,
    settings: z.object({
      enable_safety_checker: z.boolean().default(true),
    }),
    pricing: { kind: 'per_image', usd: 0.04 },
  },
  {
    endpoint: 'fal-ai/z-image/turbo',
    name: 'Z-Image Turbo',
    description: 'Fast 6B model; up to 8 steps.',
    size: { kind: 'image_size', custom: { min: 256, max: 14142 }, default: 'landscape_4_3' },
    images: { kind: 'none' },
    inputRoles: [],
    maxImages: 4,
    seed: true,
    negativePrompt: false,
    outputFormats: ['jpeg', 'png', 'webp'],
    settings: z.object({
      num_inference_steps: z.number().int().min(1).max(8).default(8),
      acceleration: acceleration.default('regular'),
      enable_safety_checker: z.boolean().default(true),
      enable_prompt_expansion: z.boolean().default(false),
    }),
    pricing: { kind: 'per_megapixel', usd: 0.005 },
  },
  {
    endpoint: 'fal-ai/qwen-image',
    name: 'Qwen Image',
    description: 'Alibaba Qwen image model with negative prompt support.',
    size: { kind: 'image_size', custom: { min: 256, max: 14142 }, default: 'landscape_4_3' },
    images: { kind: 'none' },
    inputRoles: [],
    maxImages: 4,
    seed: true,
    negativePrompt: true,
    outputFormats: ['jpeg', 'png'],
    settings: z.object({
      guidance_scale: z.number().min(0).max(20).default(2.5),
      num_inference_steps: z.number().int().min(2).max(250).default(30),
      acceleration: acceleration.default('none'),
      enable_safety_checker: z.boolean().default(true),
    }),
    pricing: { kind: 'per_megapixel', usd: 0.02 },
  },
];

export function modelIdFor(def: FalModelDef): string {
  return `${FAL_PROVIDER_ID}/${def.endpoint}`;
}

const defsById = new Map(FAL_MODELS.map((d) => [modelIdFor(d), d]));

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/** Custom `{width,height}` error for an `image_size` endpoint, or undefined when fine. */
export function validateCustomSize(size: string, rule: { min: number; max: number; step?: number }): string | undefined {
  const parsed = parseSize(size);
  if (!parsed) return `size ${size} must look like 1024x1024`;
  const { width, height } = parsed;
  if (width < rule.min || height < rule.min || width > rule.max || height > rule.max) {
    return `size ${size}: width and height must be between ${rule.min} and ${rule.max}`;
  }
  if (rule.step && (width % rule.step !== 0 || height % rule.step !== 0)) return `size ${size}: width and height must be multiples of ${rule.step}`;
  return undefined;
}

/** The size-related fal input fields for a request, or an error string. */
export function sizeFields(req: ResolvedRequest, def: FalModelDef): { fields: Record<string, JsonValue>; error?: string } {
  const { size, aspectRatio } = req.common;
  const mode = def.size;
  if (mode.kind === 'aspect_ratio') {
    // `size` is not a common key of these models, so resolve() has already dropped it.
    const ratio = aspectRatio ? canonicalRatio(aspectRatio) : undefined;
    if (ratio === undefined) return { fields: mode.default ? { aspect_ratio: mode.default } : {} };
    if (!mode.ratios.includes(ratio)) return { fields: {}, error: `aspectRatio ${aspectRatio} not supported (allowed: ${mode.ratios.join(', ')})` };
    return { fields: { aspect_ratio: ratio } };
  }
  if (size) {
    const err = validateCustomSize(size, mode.custom);
    if (err) return { fields: {}, error: err };
    const { width, height } = parseSize(size)!;
    return { fields: { image_size: { width, height } } };
  }
  if (aspectRatio) {
    const ratio = canonicalRatio(aspectRatio);
    const preset = ratio ? SIZE_PRESETS[ratio] : undefined;
    if (preset) return { fields: { image_size: preset } };
    const custom = ratio ? customSizeForRatio(ratio, mode.custom) : undefined;
    if (!custom) return { fields: {}, error: `aspectRatio ${aspectRatio} cannot be honored within ${mode.custom.min}-${mode.custom.max}px` };
    return { fields: { image_size: custom } };
  }
  return { fields: mode.default ? { image_size: mode.default } : {} };
}

/** About one megapixel at the given ratio, clamped to the endpoint's bounds and step. */
function customSizeForRatio(ratio: string, rule: { min: number; max: number; step?: number }): { width: number; height: number } | undefined {
  const parsed = parseAspectRatio(ratio);
  if (!parsed) return undefined;
  const [w, h] = parsed;
  const step = rule.step ?? 16;
  const r = w / h;
  const target = Math.max(1024 * 1024, rule.min * rule.min);
  const round = (n: number) => Math.round(n / step) * step;
  let width = round(Math.sqrt(target * r));
  let height = round(width / r);
  if (width < rule.min) {
    width = Math.ceil(rule.min / step) * step;
    height = round(width / r);
  }
  if (height < rule.min) {
    height = Math.ceil(rule.min / step) * step;
    width = round(height * r);
  }
  if (width > rule.max || height > rule.max || width < rule.min || height < rule.min) return undefined;
  return { width, height };
}

// ---------------------------------------------------------------------------
// Validation + spec
// ---------------------------------------------------------------------------

function validateRequestFor(def: FalModelDef, req: ResolvedRequest, inputs: Asset[]): string[] {
  const errors: string[] = [];
  if (req.prompt.trim() === '') errors.push('prompt is empty');
  const size = sizeFields(req, def);
  if (size.error) errors.push(size.error);
  if (req.inputs.some((i) => i.role === 'mask')) errors.push('model does not accept mask inputs');
  const images = req.inputs.filter((i) => i.role !== 'mask');
  if (def.images.kind !== 'none' && images.length > def.images.max) {
    errors.push(`${images.length} input images exceed the model maximum of ${def.images.max}`);
  }
  for (const a of inputs) {
    if (a.kind !== 'image' || !(IMAGE_MIMES as readonly string[]).includes(a.mime)) errors.push(`input ${a.id} is ${a.mime}; fal models accept png, jpeg, webp`);
  }
  return errors;
}

function specFor(def: FalModelDef): ModelSpec {
  const commonKeys: CommonKey[] = ['aspectRatio'];
  if (def.size.kind === 'image_size') commonKeys.push('size');
  if (def.seed) commonKeys.push('seed');
  if (def.outputFormats) commonKeys.push('outputFormat');
  const caps: ModelSpec['capabilities'] = {
    inputRoles: def.inputRoles,
    maxInputImages: def.images.kind === 'none' ? 0 : def.images.max,
    negativePrompt: def.negativePrompt,
    commonKeys,
    count: def.maxImages,
    ...(def.outputFormats ? { outputFormats: [...def.outputFormats] } : {}),
    ...(def.size.kind === 'aspect_ratio' ? { aspectRatios: [...def.size.ratios] } : {}),
  };
  return {
    id: modelIdFor(def),
    name: def.name,
    kind: 'image',
    description: def.description,
    capabilities: caps,
    settings: def.settings,
    pricing: describeFalPricing(def.pricing),
    validateRequest: (req, inputs) => validateRequestFor(def, req, inputs),
    ...(def.concurrency !== undefined ? { concurrency: def.concurrency } : {}),
  };
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/** fal input body for a request; `imageUrls` are the uploaded inputs in row order. */
export function buildInput(req: ResolvedRequest, def: FalModelDef, imageUrls: string[]): JsonObject {
  const settings = req.settings as Record<string, unknown>;
  const mapped = def.mapSettings ? def.mapSettings(settings, req) : (settings as Record<string, JsonValue>);
  const input: JsonObject = { prompt: req.prompt, ...sizeFields(req, def).fields };
  for (const [k, v] of Object.entries(mapped)) if (v !== undefined) input[k] = v;
  if (def.maxImages > 1) input.num_images = req.count;
  if (def.seed && req.common.seed !== undefined) input.seed = req.common.seed;
  if (def.outputFormats && req.common.outputFormat) input.output_format = req.common.outputFormat;
  if (def.negativePrompt && req.negativePrompt) input.negative_prompt = req.negativePrompt;
  if (def.images.kind === 'single' && imageUrls[0]) input[def.images.field] = imageUrls[0];
  if (def.images.kind === 'multi' && imageUrls.length > 0) input[def.images.field] = imageUrls;
  return input;
}

const submitSchema = z.object({ request_id: z.string(), status_url: z.string(), response_url: z.string(), cancel_url: z.string() }).loose();

const statusSchema = z
  .object({
    status: z.string(),
    queue_position: z.number().optional(),
    error: z.string().optional(),
    error_type: z.string().optional(),
    logs: z.array(z.object({ message: z.string().optional() }).loose()).nullish(),
    metrics: z.object({ inference_time: z.number().optional() }).loose().optional(),
  })
  .loose();

// fal sends `null` for metadata it does not have (flux-2-pro: `"file_size": null`), so every field but `url` is nullish.
const imageFileSchema = z
  .object({ url: z.string(), content_type: z.string().nullish(), width: z.number().nullish(), height: z.number().nullish(), file_size: z.number().nullish() })
  .loose();
const resultSchema = z
  .object({
    images: z.array(imageFileSchema).optional(),
    image: imageFileSchema.optional(),
    seed: z.number().optional(),
    has_nsfw_concepts: z.array(z.boolean()).optional(),
    prompt: z.string().optional(),
    description: z.string().optional(),
    timings: z.record(z.string(), z.number()).optional(),
  })
  .loose();

/** What the cost estimate needs beyond the response, recorded on the handle so `resume()` can price too. */
export type FalPricingContext = { settings: JsonObject; outputPixels?: number; inputPixels?: number[] };

export type FalRefData = {
  endpoint: string;
  requestId: string;
  statusUrl: string;
  responseUrl: string;
  cancelUrl: string;
  count: number;
  pricing?: FalPricingContext;
};

export function refDataOf(ref: ProviderRef): FalRefData {
  const d = ref.data as Record<string, unknown>;
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : undefined);
  const requestId = str('requestId');
  const statusUrl = str('statusUrl');
  const responseUrl = str('responseUrl');
  const cancelUrl = str('cancelUrl');
  if (!requestId || !statusUrl || !responseUrl || !cancelUrl) throw new ProviderError('fal: providerRef is missing queue URLs', { retryable: false, code: 'bad_ref' });
  return {
    endpoint: str('endpoint') ?? '',
    requestId,
    statusUrl,
    responseUrl,
    cancelUrl,
    count: typeof d.count === 'number' ? d.count : 1,
    ...(isPricingContext(d.pricing) ? { pricing: d.pricing } : {}),
  };
}

function isPricingContext(v: unknown): v is FalPricingContext {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  if (!p.settings || typeof p.settings !== 'object' || Array.isArray(p.settings)) return false;
  if (p.outputPixels !== undefined && typeof p.outputPixels !== 'number') return false;
  if (p.inputPixels !== undefined && !(Array.isArray(p.inputPixels) && p.inputPixels.every((n) => typeof n === 'number'))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const RETRYABLE_ERROR_TYPES = new Set([
  'request_timeout',
  'startup_timeout',
  'runner_scheduling_failure',
  'runner_connection_timeout',
  'runner_disconnected',
  'runner_connection_refused',
  'runner_connection_error',
  'runner_incomplete_response',
  'runner_server_error',
  'internal_server_error',
  'generation_timeout',
  'downstream_service_error',
  'downstream_service_unavailable',
  'concurrent_requests_limit',
]);
const CONTENT_ERROR_TYPES = new Set(['content_policy_violation', 'no_media_generated']);

interface FalErrorBody {
  message?: string;
  type?: string;
}

function parseErrorBody(text: string): FalErrorBody {
  try {
    const json = JSON.parse(text) as { detail?: unknown; error_type?: unknown; error?: unknown; message?: unknown };
    const type = typeof json.error_type === 'string' ? json.error_type : undefined;
    if (Array.isArray(json.detail)) {
      const items = json.detail as Array<{ msg?: unknown; type?: unknown; loc?: unknown[] }>;
      const message = items
        .map((i) => `${Array.isArray(i.loc) && i.loc.length ? `${i.loc.filter((p) => p !== 'body').join('.')}: ` : ''}${typeof i.msg === 'string' ? i.msg : JSON.stringify(i)}`)
        .join('; ');
      const first = items.find((i) => typeof i.type === 'string');
      return { message, type: type ?? (first?.type as string | undefined) };
    }
    if (typeof json.detail === 'string') return { message: json.detail, type };
    if (typeof json.error === 'string') return { message: json.error, type };
    if (typeof json.message === 'string') return { message: json.message, type };
    return { type };
  } catch {
    return {};
  }
}

function classifyFal(status: number, body: FalErrorBody, context: string, cause?: unknown): ProviderError {
  const detail = body.message ?? '';
  const message = `fal: ${context}: HTTP ${status}${detail ? `: ${detail}` : ''}`;
  if (status === 401 || status === 403) return new ProviderError(message, { retryable: false, code: 'auth', cause });
  if (body.type !== undefined && CONTENT_ERROR_TYPES.has(body.type)) return new ProviderError(message, { retryable: false, code: body.type, cause });
  if (body.type !== undefined && RETRYABLE_ERROR_TYPES.has(body.type)) return new ProviderError(message, { retryable: true, code: body.type, cause });
  if (status === 429 || status >= 500) return new ProviderError(message, { retryable: true, code: body.type ?? `http_${status}`, cause });
  return new ProviderError(message, { retryable: false, code: body.type ?? `http_${status}`, cause });
}

/** Failure of the submission POST: nothing was accepted unless we got a response. */
export function toSubmitError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof HttpError) return classifyFal(e.status, parseErrorBody(e.bodyText), 'submit', e);
  const msg = (e as Error)?.message ?? String(e);
  if (/timeout/i.test(msg)) {
    return new ProviderError(`fal: submit timed out; unknown whether the request was queued`, { kind: 'ambiguous', retryable: false, code: 'submit_timeout', cause: e });
  }
  return new ProviderError(`fal: submit failed: ${msg}`, { retryable: true, code: 'network', cause: e });
}

/** Failure while polling or fetching the result of an accepted request. */
export function toMonitorError(e: unknown, context: string): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof HttpError) {
    if (e.status === 404) return new ProviderError(`fal: ${context}: request not found (expired or cancelled)`, { retryable: false, code: 'not_found', cause: e });
    return classifyFal(e.status, parseErrorBody(e.bodyText), context, e);
  }
  return new ProviderError(`fal: ${context}: ${(e as Error)?.message ?? String(e)}`, { kind: 'ambiguous', retryable: false, code: 'monitor_lost', cause: e });
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const EXT_BY_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function createFalProvider(opts: FalOptions): Provider {
  const queueUrl = (opts.queueUrl ?? DEFAULT_QUEUE_URL).replace(/\/+$/, '');
  const restUrl = (opts.restUrl ?? DEFAULT_REST_URL).replace(/\/+$/, '');
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const auth = { Authorization: `Key ${opts.apiKey}` };

  /** Upload one input asset to fal storage; returns its public URL (and its pixel count when `measure`). Safe to repeat. */
  async function upload(assetId: string, ctx: GenerateContext, measure: boolean): Promise<{ url: string; pixels?: number }> {
    const a = await ctx.asset(assetId);
    const pixels = measure ? await pixelsOf(a.bytes) : undefined;
    const fileName = `${assetId}.${EXT_BY_MIME[a.mime] ?? 'bin'}`;
    let initiated: { upload_url: string; file_url: string };
    try {
      initiated = await fetchJson<{ upload_url: string; file_url: string }>(`${restUrl}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_type: a.mime, file_name: fileName }),
        timeoutMs,
        signal: ctx.signal,
        retry: { attempts: 3, backoffMs: 500, sleep: ctx.sleep },
      });
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? e;
      if (e instanceof HttpError) throw classifyFal(e.status, parseErrorBody(e.bodyText), `upload ${assetId}`, e);
      throw new ProviderError(`fal: upload ${assetId} failed: ${(e as Error)?.message ?? String(e)}`, { retryable: true, code: 'network', cause: e });
    }
    if (typeof initiated?.upload_url !== 'string' || typeof initiated?.file_url !== 'string') {
      throw new ProviderError(`fal: upload ${assetId}: unexpected initiate response`, { retryable: true, code: 'bad_response' });
    }
    try {
      await fetchWithRetry(initiated.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': a.mime },
        body: new Uint8Array(a.bytes),
        timeoutMs: Math.max(timeoutMs, 120_000),
        signal: ctx.signal,
        retry: { attempts: 3, backoffMs: 500, sleep: ctx.sleep },
      });
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? e;
      throw new ProviderError(`fal: upload ${assetId} failed: ${(e as Error)?.message ?? String(e)}`, { retryable: true, code: 'upload_failed', cause: e });
    }
    return { url: initiated.file_url, ...(pixels !== undefined ? { pixels } : {}) };
  }

  async function monitor(data: FalRefData, def: FalModelDef | undefined, ctx: GenerateContext): Promise<GenerateResult> {
    const started = Date.now();
    let lastStatus = '';
    let lastPosition: number | undefined;
    for (;;) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
      let status: z.infer<typeof statusSchema>;
      try {
        const raw = await fetchJson(data.statusUrl, {
          headers: auth,
          timeoutMs,
          signal: ctx.signal,
          retry: { attempts: 4, backoffMs: 500, sleep: ctx.sleep },
        });
        const parsed = statusSchema.safeParse(raw);
        if (!parsed.success) throw new ProviderError('fal: unexpected status response', { retryable: false, code: 'bad_response' });
        status = parsed.data;
      } catch (e) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? e;
        throw toMonitorError(e, `status ${data.requestId}`);
      }

      if (status.status !== lastStatus || status.queue_position !== lastPosition) {
        lastStatus = status.status;
        lastPosition = status.queue_position;
        ctx.log(`fal: ${data.requestId} ${status.status}${status.queue_position !== undefined ? ` (queue position ${status.queue_position})` : ''}`);
      }

      if (status.status === 'COMPLETED') {
        if (status.error || status.error_type) {
          const type = status.error_type;
          const message = `fal: request failed: ${status.error ?? type ?? 'unknown error'}`;
          if (type !== undefined && CONTENT_ERROR_TYPES.has(type)) throw new ProviderError(message, { retryable: false, code: type });
          throw new ProviderError(message, { retryable: type !== undefined && RETRYABLE_ERROR_TYPES.has(type), code: type ?? 'failed' });
        }
        return await fetchResult(data, def, status, ctx);
      }
      if (status.status !== 'IN_QUEUE' && status.status !== 'IN_PROGRESS') {
        throw new ProviderError(`fal: unexpected queue status ${status.status}`, { kind: 'ambiguous', retryable: false, code: 'unknown_status' });
      }
      if (Date.now() - started > maxWaitMs) {
        throw new ProviderError(`fal: request ${data.requestId} still ${status.status} after ${Math.round(maxWaitMs / 1000)}s`, {
          kind: 'ambiguous',
          retryable: false,
          code: 'monitor_timeout',
        });
      }
      await ctx.sleep(pollMs);
    }
  }

  async function fetchResult(data: FalRefData, def: FalModelDef | undefined, status: z.infer<typeof statusSchema>, ctx: GenerateContext): Promise<GenerateResult> {
    let raw: unknown;
    try {
      raw = await fetchJson(data.responseUrl, { headers: auth, timeoutMs, signal: ctx.signal, retry: { attempts: 4, backoffMs: 500, sleep: ctx.sleep } });
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? e;
      // The response endpoint replays the runner's error (422 content policy, 5xx runner failure).
      if (e instanceof HttpError && e.status === 422) {
        const body = parseErrorBody(e.bodyText);
        throw new ProviderError(`fal: request failed${body.message ? `: ${body.message}` : ''}`, {
          retryable: false,
          code: body.type ?? 'validation',
          cause: e,
        });
      }
      throw toMonitorError(e, `response ${data.requestId}`);
    }
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`).join('; ');
      throw new ProviderError(`fal: unexpected result shape (${issues})`, { retryable: false, code: 'bad_response' });
    }
    const result = parsed.data;
    const files = result.images ?? (result.image ? [result.image] : []);
    const outputs: OutputDescriptor[] = files.map((f, i) => ({
      url: f.url,
      ...(f.content_type ? { mime: f.content_type } : {}),
      meta: {
        ...(f.width != null ? { width: f.width } : {}),
        ...(f.height != null ? { height: f.height } : {}),
        ...(result.has_nsfw_concepts?.[i] !== undefined ? { nsfw: result.has_nsfw_concepts[i]! } : {}),
      },
    }));
    if (outputs.length === 0) throw new ProviderError('fal: response contained no images', { retryable: false, code: 'no_output' });

    const providerMeta: JsonValue = {
      endpoint: data.endpoint,
      requestId: data.requestId,
      ...(result.seed !== undefined ? { seed: result.seed } : {}),
      ...(result.prompt !== undefined ? { prompt: result.prompt } : {}),
      ...(result.description !== undefined ? { description: result.description } : {}),
      ...(result.timings ? { timings: result.timings } : {}),
      ...(status.metrics?.inference_time !== undefined ? { inferenceTime: status.metrics.inference_time } : {}),
    };
    const cost = def ? estimateFalCost(def.pricing, costInputFor(data, outputs)) : undefined;
    return { outputs, ...(cost !== undefined ? { cost } : {}), providerMeta };
  }

  /** Output pixels come from the response when fal reports them, else from the size we asked for. */
  function costInputFor(data: FalRefData, outputs: OutputDescriptor[]): FalCostInput {
    const outputPixels = outputs.map((o) => {
      const m = (o.meta ?? {}) as { width?: unknown; height?: unknown };
      return typeof m.width === 'number' && typeof m.height === 'number' ? m.width * m.height : data.pricing?.outputPixels;
    });
    return {
      settings: data.pricing?.settings ?? {},
      outputPixels,
      ...(data.pricing?.inputPixels ? { inputPixels: data.pricing.inputPixels } : {}),
    };
  }

  return {
    id: FAL_PROVIDER_ID,
    name: 'fal',
    concurrency: opts.concurrency ?? 4,
    models: FAL_MODELS.map(specFor),

    async generate(req, ctx) {
      const def = defsById.get(req.model);
      if (!def) throw new ProviderError(`unknown fal model ${req.model}`, { kind: 'unsupported' });

      const imageInputs = req.inputs.filter((i) => i.role !== 'mask');
      const measure = def.pricing.kind === 'flux2_pro';
      const imageUrls: string[] = [];
      const inputPixels: number[] = [];
      for (const i of imageInputs) {
        const up = await upload(i.asset, ctx, measure);
        imageUrls.push(up.url);
        if (up.pixels !== undefined) inputPixels.push(up.pixels);
      }
      const input = buildInput(req, def, imageUrls);
      const outputPixels = requestedOutputPixels(sizeFields(req, def).fields);
      const pricing: FalPricingContext = {
        settings: req.settings as JsonObject,
        ...(outputPixels !== undefined ? { outputPixels } : {}),
        // Only complete when every input could be measured; a partial sum would under-price.
        ...(inputPixels.length === imageInputs.length ? { inputPixels } : {}),
      };

      let submitted: z.infer<typeof submitSchema>;
      try {
        ctx.log(`fal: submit ${def.endpoint}${imageUrls.length ? ` images=${imageUrls.length}` : ''}`);
        const raw = await fetchJson(`${queueUrl}/${def.endpoint}`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          timeoutMs,
          signal: ctx.signal,
        });
        const parsed = submitSchema.safeParse(raw);
        if (!parsed.success) throw new ProviderError('fal: unexpected submit response', { kind: 'ambiguous', retryable: false, code: 'bad_response' });
        submitted = parsed.data;
      } catch (e) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? e;
        throw toSubmitError(e);
      }

      const data: FalRefData = {
        endpoint: def.endpoint,
        requestId: submitted.request_id,
        statusUrl: submitted.status_url,
        responseUrl: submitted.response_url,
        cancelUrl: submitted.cancel_url,
        count: req.count,
        pricing,
      };
      await ctx.setProviderRef({ version: REF_VERSION, model: req.model, data: { ...data } });
      return monitor(data, def, ctx);
    },

    async resume(ref, ctx) {
      const data = refDataOf(ref);
      ctx.log(`fal: resume ${data.requestId}`);
      return monitor(data, defsById.get(ref.model), ctx);
    },

    async cancel(ref): Promise<CancelOutcome> {
      const data = refDataOf(ref);
      try {
        await fetchWithRetry(data.cancelUrl, { method: 'PUT', headers: auth, timeoutMs, retry: { attempts: 2, backoffMs: 300 } });
      } catch (e) {
        // 400 ALREADY_COMPLETED: the result exists; monitoring will fetch it.
        if (e instanceof HttpError && e.status === 400) return 'pending';
        // 404 NOT_FOUND: nothing is running under this handle.
        if (e instanceof HttpError && e.status === 404) return 'confirmed';
        if (e instanceof HttpError && !isRetryableStatus(e.status)) return 'unsupported';
        throw e;
      }
      // 202 CANCELLATION_REQUESTED drops a queued request at once but only signals a running one.
      // Confirm by asking the queue whether the request is still known.
      try {
        const raw = await fetchJson(data.statusUrl, { headers: auth, timeoutMs, retry: { attempts: 2, backoffMs: 300 } });
        const parsed = statusSchema.safeParse(raw);
        return parsed.success && parsed.data.status === 'COMPLETED' && (parsed.data.error_type === 'client_cancelled' || parsed.data.error !== undefined) ? 'confirmed' : 'pending';
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return 'confirmed';
        return 'pending';
      }
    },
  };
}
