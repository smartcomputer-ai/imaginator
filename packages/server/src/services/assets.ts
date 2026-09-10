import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import { isRowRef, type AssetView } from '@imaginator/core';
import { nowIso } from '../db/index.js';
import { assets, generations, rows, type AssetRow } from '../db/schema.js';
import { invalid, notFound } from '../errors.js';
import { newAssetId, toAssetView, transact, type ServiceContext } from './context.js';

export interface UploadInput {
  bytes?: string;
  path?: string;
  url?: string;
  mime?: string;
  label?: string;
}

export function createAssetService(ctx: ServiceContext) {
  const { store } = ctx;

  function buildThumb(id: string, ext: string): void {
    store.ensureThumb(id, ext).catch((e) => ctx.config.log(`thumbnail for ${id} failed: ${(e as Error).message}`));
  }

  return {
    getRow(id: string): AssetRow | undefined {
      return ctx.db.select().from(assets).where(eq(assets.id, id)).get();
    },

    requireRow(id: string): AssetRow {
      const a = this.getRow(id);
      if (!a) throw notFound(`asset ${id}`);
      return a;
    },

    get(id: string): AssetView {
      return toAssetView(this.requireRow(id));
    },

    allocateId(): string {
      return newAssetId(ctx.db);
    },

    /** Upload from base64 bytes, a local path, or a URL. Dedups by sha256. */
    async upload(input: UploadInput): Promise<AssetView> {
      let staged: string;
      let mimeHint = input.mime;
      if (input.bytes !== undefined) {
        const raw = input.bytes.startsWith('data:') ? input.bytes.slice(input.bytes.indexOf(',') + 1) : input.bytes;
        const buf = Buffer.from(raw, 'base64');
        if (buf.length === 0) throw invalid('bytes is empty or not base64');
        staged = await store.stageBytes(buf, mimeHint);
      } else if (input.path !== undefined) {
        if (!fs.existsSync(input.path)) throw invalid(`path not found: ${input.path}`);
        staged = await store.stageBytes(await fsp.readFile(input.path), mimeHint);
      } else if (input.url !== undefined) {
        const r = await store.stageUrl(input.url, { mime: mimeHint });
        staged = r.path;
        mimeHint = mimeHint ?? r.mime;
      } else {
        throw invalid('provide exactly one of bytes, path, url');
      }
      let analyzed;
      try {
        analyzed = await store.analyze(staged, mimeHint);
      } catch (e) {
        await store.discardStaged(staged);
        throw e;
      }
      const existing = ctx.db.select().from(assets).where(eq(assets.sha256, analyzed.sha256)).get();
      if (existing && store.originalExists(existing.id, existing.ext)) {
        await store.discardStaged(staged);
        if (input.label !== undefined && existing.label !== input.label) return this.label(existing.id, input.label);
        return toAssetView(existing);
      }
      const id = newAssetId(ctx.db);
      const placed = await store.place(analyzed, id);
      let row: AssetRow;
      try {
        row = transact(ctx, (tx, emit) => {
          const inserted: AssetRow = {
            id,
            kind: placed.kind,
            originType: 'upload',
            originGeneration: null,
            mime: placed.mime,
            ext: placed.ext,
            width: placed.width,
            height: placed.height,
            bytes: placed.bytes,
            sha256: placed.sha256,
            label: input.label ?? null,
            createdAt: nowIso(),
          };
          tx.insert(assets).values(inserted).run();
          emit({ type: 'asset.created', id });
          return inserted;
        });
      } catch (e) {
        await store.unplace(placed);
        throw e;
      }
      buildThumb(id, placed.ext);
      return toAssetView(row);
    },

    list(opts: { origin?: 'upload' | 'generation'; label?: string; limit?: number; offset?: number } = {}): { assets: AssetView[]; total: number } {
      const conds = [];
      if (opts.origin) conds.push(eq(assets.originType, opts.origin));
      if (opts.label) conds.push(like(assets.label, `%${opts.label.replace(/[%_]/g, '\\$&')}%`));
      const where = conds.length ? and(...conds) : undefined;
      const total = ctx.db.select({ n: sql<number>`count(*)` }).from(assets).where(where).get()?.n ?? 0;
      const list = ctx.db
        .select()
        .from(assets)
        .where(where)
        .orderBy(desc(assets.createdAt), desc(assets.id))
        .limit(opts.limit ?? 100)
        .offset(opts.offset ?? 0)
        .all();
      return { assets: list.map(toAssetView), total };
    },

    label(id: string, label: string | null): AssetView {
      return transact(ctx, (tx) => {
        const a = tx.select().from(assets).where(eq(assets.id, id)).get();
        if (!a) throw notFound(`asset ${id}`);
        tx.update(assets).set({ label }).where(eq(assets.id, id)).run();
        return toAssetView({ ...a, label });
      });
    },

    /** Set of asset ids referenced by any row input or generation output. */
    referencedIds(): Set<string> {
      const refs = new Set<string>();
      for (const r of ctx.db.select({ inputs: rows.inputs }).from(rows).all()) for (const i of r.inputs) if (!isRowRef(i)) refs.add(i.asset);
      for (const g of ctx.db.select({ outputs: generations.outputs }).from(generations).all()) for (const id of g.outputs) refs.add(id);
      return refs;
    },

    /** Remove assets referenced by nothing, plus files under assets/ with no row. */
    async gc(dryRun = false): Promise<{ removed: string[]; orphanFiles: number; dryRun: boolean }> {
      const refs = this.referencedIds();
      const all = ctx.db.select().from(assets).all();
      const unreferenced = all.filter((a) => !refs.has(a.id));
      const known = new Set(all.map((a) => a.id));
      const files = await store.listOriginalFiles();
      const orphans = [...files].filter(([id]) => !known.has(id));
      if (!dryRun) {
        if (unreferenced.length > 0) {
          transact(ctx, (tx) => {
            for (const a of unreferenced) tx.delete(assets).where(eq(assets.id, a.id)).run();
          });
          for (const a of unreferenced) await store.removeFiles(a.id, a.ext);
        }
        for (const [id, file] of orphans) {
          await fsp.unlink(file).catch(() => {});
          await store.removeThumbs(id);
        }
      }
      return { removed: unreferenced.map((a) => a.id), orphanFiles: orphans.length, dryRun };
    },

    /** Ensure a thumbnail exists; returns its path. */
    thumb(id: string): Promise<string> {
      const a = this.requireRow(id);
      return store.ensureThumb(a.id, a.ext);
    },
  };
}

export type AssetService = ReturnType<typeof createAssetService>;
