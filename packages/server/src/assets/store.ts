import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { randomId } from '@imaginator/core';
import { ServiceError } from '../errors.js';
import { fetchBytes } from '../providers/http.js';

export type SniffedMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? (mime.includes('/') ? mime.split('/')[1]!.replace(/[^a-z0-9]/g, '') || 'bin' : 'bin');
}

/** Magic-byte sniff; undefined when unknown. */
export function sniffMime(bytes: Uint8Array): SniffedMime | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  return undefined;
}

export interface AnalyzedFile {
  path: string;
  mime: string;
  ext: string;
  kind: 'image' | 'video';
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export interface PlacedFile extends AnalyzedFile {
  id: string;
  finalPath: string;
}

export const THUMB_MAX = 320;

/**
 * Filesystem side of assets. `data/tmp` holds staged bytes; `data/assets/<shard>/`
 * holds originals plus `<id>.thumb.webp`. Rows live in the DB (services).
 */
export class AssetStore {
  readonly assetsDir: string;
  readonly tmpDir: string;

  constructor(readonly dataDir: string) {
    this.assetsDir = path.join(dataDir, 'assets');
    this.tmpDir = path.join(dataDir, 'tmp');
    fs.mkdirSync(this.assetsDir, { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  // -- staging --------------------------------------------------------------

  tmpPath(hint = 'bin'): string {
    return path.join(this.tmpDir, `${Date.now().toString(36)}-${randomId(8)}.${hint}`);
  }

  /** Write bytes to a durable staged file under data/tmp. */
  async stageBytes(bytes: Uint8Array, mime?: string): Promise<string> {
    const p = this.tmpPath(extForMime(mime ?? sniffMime(bytes) ?? 'application/octet-stream'));
    await fsp.writeFile(p, bytes, { flag: 'wx' });
    return p;
  }

  /** Download a URL into data/tmp (retrying: downloads are safe to repeat). */
  async stageUrl(url: string, opts: { signal?: AbortSignal; mime?: string } = {}): Promise<{ path: string; mime: string | undefined }> {
    if (url.startsWith('file://')) {
      const src = new URL(url).pathname;
      const bytes = await fsp.readFile(src);
      return { path: await this.stageBytes(bytes, opts.mime), mime: opts.mime };
    }
    const { bytes, mime } = await fetchBytes(url, { signal: opts.signal, retry: { attempts: 4, backoffMs: 300 }, timeoutMs: 120_000 });
    const chosen = opts.mime ?? (mime && mime !== 'application/octet-stream' ? mime : undefined);
    return { path: await this.stageBytes(bytes, chosen), mime: chosen };
  }

  // -- analysis + placement --------------------------------------------------

  /** Sniff mime, hash, and measure a staged file. */
  async analyze(filePath: string, mimeHint?: string): Promise<AnalyzedFile> {
    const bytes = await fsp.readFile(filePath);
    let mime: string | undefined = sniffMime(bytes);
    let width = 0;
    let height = 0;
    try {
      const meta = await sharp(bytes).metadata();
      width = meta.width ?? 0;
      height = meta.height ?? 0;
      if (!mime && meta.format) mime = `image/${meta.format === 'jpg' ? 'jpeg' : meta.format}`;
    } catch (e) {
      if (!mime) {
        if (mimeHint?.startsWith('video/')) mime = mimeHint;
        else throw new ServiceError('validation', `not a supported image: ${(e as Error).message}`);
      }
    }
    if (!mime) mime = mimeHint ?? 'application/octet-stream';
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      path: filePath,
      mime,
      ext: extForMime(mime),
      kind: mime.startsWith('video/') ? 'video' : 'image',
      width,
      height,
      bytes: bytes.length,
      sha256,
    };
  }

  shardDir(id: string): string {
    return path.join(this.assetsDir, id.slice(0, 2));
  }

  originalPath(id: string, ext: string): string {
    return path.join(this.shardDir(id), `${id}.${ext}`);
  }

  thumbPath(id: string): string {
    return path.join(this.shardDir(id), `${id}.thumb.webp`);
  }

  /** Atomically move an analyzed staged file into its final location. */
  async place(analyzed: AnalyzedFile, id: string): Promise<PlacedFile> {
    const finalPath = this.originalPath(id, analyzed.ext);
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    try {
      await fsp.rename(analyzed.path, finalPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
        await fsp.copyFile(analyzed.path, finalPath, fs.constants.COPYFILE_EXCL);
        await fsp.unlink(analyzed.path);
      } else throw e;
    }
    return { ...analyzed, id, finalPath };
  }

  /** Best-effort removal of a placed original (used when the DB insert fails). */
  async unplace(placed: PlacedFile): Promise<void> {
    await fsp.unlink(placed.finalPath).catch(() => {});
  }

  async removeFiles(id: string, ext: string): Promise<void> {
    await fsp.unlink(this.originalPath(id, ext)).catch(() => {});
    await fsp.unlink(this.thumbPath(id)).catch(() => {});
  }

  async discardStaged(filePath: string): Promise<void> {
    await fsp.unlink(filePath).catch(() => {});
  }

  // -- reading ----------------------------------------------------------------

  async readOriginal(id: string, ext: string): Promise<Uint8Array> {
    try {
      return await fsp.readFile(this.originalPath(id, ext));
    } catch (e) {
      throw new ServiceError('storage', `asset ${id} original is missing on disk (${(e as Error).message})`);
    }
  }

  originalExists(id: string, ext: string): boolean {
    return fs.existsSync(this.originalPath(id, ext));
  }

  /** Create the thumbnail if missing; returns its path. Throws a storage error when the original is missing. */
  async ensureThumb(id: string, ext: string): Promise<string> {
    const thumb = this.thumbPath(id);
    if (fs.existsSync(thumb)) return thumb;
    const original = this.originalPath(id, ext);
    if (!fs.existsSync(original)) throw new ServiceError('storage', `asset ${id} original is missing on disk`);
    const tmp = `${thumb}.${randomId(6)}.tmp`;
    try {
      await sharp(original, { animated: false })
        .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(tmp);
      await fsp.rename(tmp, thumb);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      if (fs.existsSync(thumb)) return thumb;
      throw new ServiceError('storage', `could not build thumbnail for ${id}: ${(e as Error).message}`);
    }
    return thumb;
  }

  // -- maintenance -------------------------------------------------------------

  /** Remove files in data/tmp older than `graceMs` unless listed in `preserve`. */
  async sweepTmp(preserve: Set<string>, graceMs: number): Promise<number> {
    let removed = 0;
    const cutoff = Date.now() - graceMs;
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(this.tmpDir);
    } catch {
      return 0;
    }
    for (const name of entries) {
      const p = path.join(this.tmpDir, name);
      if (preserve.has(p) || preserve.has(path.resolve(p))) continue;
      try {
        const st = await fsp.stat(p);
        if (st.mtimeMs < cutoff) {
          await fsp.rm(p, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* ignore */
      }
    }
    return removed;
  }

  /** Every `<id>.<ext>` original file under assets/, keyed by id. Thumbs are ignored. */
  async listOriginalFiles(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let shards: string[] = [];
    try {
      shards = await fsp.readdir(this.assetsDir);
    } catch {
      return out;
    }
    for (const shard of shards) {
      const dir = path.join(this.assetsDir, shard);
      let files: string[] = [];
      try {
        const st = await fsp.stat(dir);
        if (!st.isDirectory()) continue;
        files = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.includes('.thumb.') || f.endsWith('.tmp')) continue;
        const id = f.slice(0, f.indexOf('.'));
        if (id) out.set(id, path.join(dir, f));
      }
    }
    return out;
  }
}
