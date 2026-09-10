import fsp from 'node:fs/promises';
import sharp from 'sharp';
import type { AssetStore } from '../assets/store.js';
import type { AssetRow } from '../db/schema.js';

/**
 * How an image is rendered into a tool result.
 *
 * - `small`: <=512px webp, quality 72. Typically 15-40 KB, enough to judge
 *   composition, subject, and obvious defects. The default, because several
 *   clients meter tool results by raw bytes (Claude Code counts base64 as
 *   text against MAX_MCP_OUTPUT_TOKENS, Claude Desktop caps results at about
 *   150k characters), so an 800px image can cost more than a whole grid.
 * - `medium`: the existing <=800px webp thumbnail (quality 85, 50-200 KB).
 * - `full`: the original, re-encoded only above 1568px or 3 MB; vision
 *   models downscale beyond that anyway.
 */
export type ImageSize = 'small' | 'medium' | 'full';
export const imageSizes = ['small', 'medium', 'full'] as const;

export const SMALL_MAX_EDGE = 512;
export const SMALL_QUALITY = 72;
/** Longest edge for `full`; Claude, GPT and Gemini all resize above roughly this. */
export const FULL_MAX_EDGE = 1568;
/** Above this, `full` is re-encoded even when the dimensions fit. */
export const FULL_MAX_BYTES = 3 * 1024 * 1024;

export interface ModelImage {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
}

const INLINE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Render an asset as base64 for an MCP `image` content block; undefined for non-images. */
export async function imageForModel(store: AssetStore, asset: AssetRow, size: ImageSize): Promise<ModelImage | undefined> {
  if (asset.kind !== 'image') return undefined;
  if (size === 'medium' || size === 'small') {
    const thumb = await store.ensureThumb(asset.id, asset.ext);
    const buf = await fsp.readFile(thumb);
    if (size === 'medium') {
      const meta = await sharp(buf).metadata();
      return { data: buf.toString('base64'), mimeType: 'image/webp', width: meta.width ?? 0, height: meta.height ?? 0, bytes: buf.length };
    }
    const out = await sharp(buf)
      .resize({ width: SMALL_MAX_EDGE, height: SMALL_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: SMALL_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { data: out.data.toString('base64'), mimeType: 'image/webp', width: out.info.width, height: out.info.height, bytes: out.data.length };
  }
  const original = await store.readOriginal(asset.id, asset.ext);
  const fits = Math.max(asset.width, asset.height) <= FULL_MAX_EDGE && original.length <= FULL_MAX_BYTES;
  if (fits && INLINE_MIMES.has(asset.mime)) {
    return { data: Buffer.from(original).toString('base64'), mimeType: asset.mime, width: asset.width, height: asset.height, bytes: original.length };
  }
  const out = await sharp(original, { animated: false })
    .resize({ width: FULL_MAX_EDGE, height: FULL_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 90 })
    .toBuffer({ resolveWithObject: true });
  return { data: out.data.toString('base64'), mimeType: 'image/webp', width: out.info.width, height: out.info.height, bytes: out.data.length };
}
