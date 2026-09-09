import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { sniffMime } from '../src/assets/store.js';
import { pngBase64, pngBytes } from './fixtures.js';
import { bootApp, cell, run, settle, until } from './helpers.js';

let app: App;
afterEach(async () => {
  await app?.stop();
});

describe('assets', () => {
  it('sniffs mime from magic bytes', async () => {
    expect(sniffMime(await pngBytes(2, 2))).toBe('image/png');
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(new TextEncoder().encode('RIFF....WEBPVP8 '))).toBe('image/webp');
    expect(sniffMime(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(sniffMime(new TextEncoder().encode('hello'))).toBeUndefined();
  });

  it('uploads from base64, path and file URL; dedups by sha256; labels', async () => {
    app = await bootApp();
    const b64 = await pngBase64(12, 8);
    const a = await run(app, 'assets.upload', { bytes: b64, label: 'first' });
    expect(a.asset).toMatchObject({ kind: 'image', mime: 'image/png', width: 12, height: 8, origin: { type: 'upload' }, label: 'first' });
    expect(a.asset.url).toBe(`/assets/${a.asset.id}`);
    expect(fs.existsSync(app.store.originalPath(a.asset.id, 'png'))).toBe(true);
    await until(() => fs.existsSync(app.store.thumbPath(a.asset.id)));

    const again = await run(app, 'assets.upload', { bytes: b64 });
    expect(again.asset.id).toBe(a.asset.id);

    const file = path.join(app.config.dataDir, 'in.png');
    fs.writeFileSync(file, await pngBytes(5, 5));
    const fromPath = await run(app, 'assets.upload', { path: file });
    expect(fromPath.asset.width).toBe(5);
    const fromUrl = await run(app, 'assets.upload', { url: `file://${file}` });
    expect(fromUrl.asset.id).toBe(fromPath.asset.id);

    const labelled = await run(app, 'assets.label', { asset: fromPath.asset.id, label: 'five' });
    expect(labelled.asset.label).toBe('five');
    const list = await run(app, 'assets.list', { label: 'fiv' });
    expect(list.assets.map((x) => x.id)).toEqual([fromPath.asset.id]);
    expect((await run(app, 'assets.list', {})).total).toBe(2);
    const cleared = await run(app, 'assets.label', { asset: fromPath.asset.id, label: null });
    expect(cleared.asset.label).toBeUndefined();

    await expect(run(app, 'assets.upload', { bytes: Buffer.from('not an image').toString('base64') })).rejects.toThrow(/not a supported image/);
    await expect(run(app, 'assets.upload', { bytes: b64, path: file })).rejects.toThrow(/invalid input/);
    expect(fs.readdirSync(app.store.tmpDir)).toHaveLength(0);
  });

  it('img2img reads input assets; uploaded inputs survive regeneration of their consumer', async () => {
    app = await bootApp();
    const init = await run(app, 'assets.upload', { bytes: await pngBase64(64, 48, { r: 0, g: 0, b: 255, alpha: 1 }) });
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/img2img' }],
      rows: [{ prompt: 'tint', inputs: [{ asset: init.asset.id, role: 'init' }], settings: { aspectRatio: '4:3' } }],
    });
    let view = await settle(app, 'c');
    expect(cell(view, 'r1', 'img2img').status).toBe('succeeded');
    const out = await run(app, 'assets.get', { asset: cell(view, 'r1', 'img2img').outputs[0]! });
    expect(out.asset.width / out.asset.height).toBeCloseTo(4 / 3, 1);
    await run(app, 'cells.regenerate', { cell: 'c/r1/img2img' });
    view = await settle(app, 'c');
    expect(cell(view, 'r1', 'img2img').versions).toBe(2);
    expect((await run(app, 'assets.get', { asset: init.asset.id })).asset.id).toBe(init.asset.id);
    await expect(run(app, 'rows.add', { collection: 'c', rows: [{ prompt: 'x', inputs: [{ asset: 'zzzzzz', role: 'init' }] }] })).rejects.toThrow(/not found/);
  });

  it('assets.gc keeps referenced assets and removes the rest plus orphan files', async () => {
    app = await bootApp();
    const used = await run(app, 'assets.upload', { bytes: await pngBase64(10, 10, { r: 1, g: 2, b: 3, alpha: 1 }) });
    const unused = await run(app, 'assets.upload', { bytes: await pngBase64(10, 10, { r: 9, g: 9, b: 9, alpha: 1 }) });
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/img2img' }, { model: 'mock/img2img', id: 'img2img-2', settings: { hue: 10 } }],
      rows: [{ prompt: 'ref', inputs: [{ asset: used.asset.id, role: 'reference' }] }],
    });
    const view = await settle(app, 'c');
    const outputs = view.cells.flatMap((c) => c.outputs);
    expect(outputs).toHaveLength(2);
    const orphan = path.join(app.store.shardDir('zz'), 'zzzzzz.png');
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, 'x');

    const dry = await run(app, 'assets.gc', { dryRun: true });
    expect(dry).toEqual({ removed: [unused.asset.id], orphanFiles: 1, dryRun: true });
    expect(fs.existsSync(orphan)).toBe(true);
    const gc = await run(app, 'assets.gc', {});
    expect(gc.removed).toEqual([unused.asset.id]);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(app.store.originalPath(unused.asset.id, 'png'))).toBe(false);
    expect(fs.existsSync(app.store.originalPath(used.asset.id, 'png'))).toBe(true);
    for (const id of outputs) expect((await run(app, 'assets.get', { asset: id })).asset.id).toBe(id);
    await expect(run(app, 'assets.get', { asset: unused.asset.id })).rejects.toThrow(/not found/);

    // Deleting the collection keeps outputs until the next gc.
    await run(app, 'collections.delete', { collection: 'c' });
    for (const id of outputs) expect((await run(app, 'assets.get', { asset: id })).asset.id).toBe(id);
    const gc2 = await run(app, 'assets.gc', {});
    expect(gc2.removed.sort()).toEqual([...outputs, used.asset.id].sort());
  });
});
