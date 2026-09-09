import { z } from 'zod';
import { jsonValueSchema, type JsonObject } from './json.js';

export const OUTPUT_FORMATS = ['png', 'jpeg', 'webp'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const ASPECT_RATIO_RE = /^[1-9][0-9]*:[1-9][0-9]*$/;
export const SIZE_RE = /^[1-9][0-9]*x[1-9][0-9]*$/;

/**
 * CommonSettings: the small shared vocabulary owned by rows (with collection
 * defaults filling gaps). Strict: a row cannot smuggle model keys in here.
 */
export const commonSettingsSchema = z
  .object({
    aspectRatio: z.string().regex(ASPECT_RATIO_RE, 'aspectRatio must look like 16:9').optional(),
    size: z.string().regex(SIZE_RE, 'size must look like 1024x1024').optional(),
    seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    outputFormat: z.enum(OUTPUT_FORMATS).optional(),
  })
  .strict();
export type CommonSettings = z.infer<typeof commonSettingsSchema>;

export const COMMON_KEYS = ['aspectRatio', 'size', 'seed', 'outputFormat'] as const;
export type CommonKey = (typeof COMMON_KEYS)[number];
export const commonKeySchema = z.enum(COMMON_KEYS);

export function isCommonKey(key: string): key is CommonKey {
  return (COMMON_KEYS as readonly string[]).includes(key);
}

/**
 * ModelSettings: provider-specific knobs owned by columns. Shape is validated
 * against the model's own zod schema at resolve time; here we only guarantee
 * JSON-ness and that no common key leaks in.
 */
export const modelSettingsSchema: z.ZodType<JsonObject> = z
  .record(z.string(), jsonValueSchema)
  .refine((obj) => !Object.keys(obj).some(isCommonKey), {
    message: `model settings cannot contain common keys (${COMMON_KEYS.join(', ')}); set those on the row or collection defaults`,
  });
export type ModelSettings = JsonObject;

export function parseAspectRatio(value: string): [number, number] | undefined {
  const m = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(value);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

export function parseSize(value: string): { width: number; height: number } | undefined {
  const m = /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(value);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Reduces `16:9`, `1920x1080` etc. to a canonical `w:h` string, or undefined. */
export function canonicalRatio(value: string): string | undefined {
  const ratio = parseAspectRatio(value);
  const size = parseSize(value);
  const [w, h] = ratio ?? (size ? [size.width, size.height] : [undefined, undefined]);
  if (w === undefined || h === undefined) return undefined;
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}
