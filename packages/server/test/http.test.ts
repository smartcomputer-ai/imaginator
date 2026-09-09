import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { pngBytes } from './fixtures.js';
import { bootApp, until } from './helpers.js';

let app: App;
afterEach(async () => {
  await app?.stop();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function post(base: string, name: string, body: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${base}/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

async function getJson(url: string): Promise<Json> {
  return (await fetch(url)).json();
}

describe('http', () => {
  it('drives the whole flow over HTTP: create → columns → rows → wait → get → assets', async () => {
    app = await bootApp();
    const base = await app.listen(0);

    const health = await getJson(`${base}/api/health`);
    expect(health.ok).toBe(true);

    const models = await getJson(`${base}/api/models.list`);
    expect(models.models.map((m: { id: string }) => m.id)).toContain('mock/fast');
    expect(models.models[0].settingsSchema.type).toBe('object');

    const created = await post(base, 'collections.create', { slug: 'http', title: 'HTTP' });
    expect(created.status).toBe(200);
    expect(created.json.status).toBe('live');
    const col = await post(base, 'columns.add', { collection: 'http', model: 'mock/fast' });
    expect(col.json.column.id).toBe('fast');
    const col2 = await post(base, 'columns.add', { collection: 'http', model: 'mock/fast', settings: { hue: 200 } });
    expect(col2.json.column.id).toBe('fast-2');
    const rows = await post(base, 'rows.add', { collection: 'http', rows: [{ prompt: 'one' }, { prompt: 'two' }] });
    expect(rows.json.rows.map((r: { id: string }) => r.id)).toEqual(['r1', 'r2']);

    let cursor = rows.json.cursor as string;
    for (let i = 0; i < 30; i++) {
      const w = await post(base, 'collections.wait', { collection: 'http', cursor, timeoutMs: 5000 });
      expect(w.status).toBe(200);
      cursor = w.json.cursor;
      if (w.json.inFlight === 0 && w.json.queued === 0) break;
    }
    const view = await getJson(`${base}/api/collections.get?collection=http`);
    expect(view.cells).toHaveLength(4);
    expect(view.cells.every((c: { status: string }) => c.status === 'succeeded')).toBe(true);
    const url = view.cells[0].urls[0] as string;
    const img = await fetch(`${base}${url}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('cache-control')).toMatch(/immutable/);
    expect((await img.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    const thumb = await fetch(`${base}${view.cells[0].thumbnails[0]}`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    expect((await thumb.arrayBuffer()).byteLength).toBeGreaterThan(100);

    const cellGet = await getJson(`${base}/api/cells.get?cell=http/r1/fast`);
    expect(cellGet.current.status).toBe('succeeded');
    const list = await getJson(`${base}/api/collections.list`);
    expect(list.collections[0]).toMatchObject({ slug: 'http', cells: 4, succeeded: 4 });
    const assets = await getJson(`${base}/api/assets.list?limit=2&origin="generation"`);
    expect(assets.assets).toHaveLength(2);
    expect(assets.total).toBe(4);
  });

  it('returns structured errors with the right status codes', async () => {
    app = await bootApp();
    const base = await app.listen(0);
    const bad = await post(base, 'collections.create', { slug: 'Not A Slug' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('validation');
    expect(bad.json.error.issues.length).toBeGreaterThan(0);

    const missing = await post(base, 'collections.get', { collection: 'nope' });
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('not_found');

    await post(base, 'collections.create', { slug: 'dup', status: 'paused' });
    const dup = await post(base, 'collections.create', { slug: 'dup' });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('conflict');

    const unknownModel = await post(base, 'columns.add', { collection: 'dup', model: 'nope/model' });
    expect(unknownModel.status).toBe(400);

    const notJson = await fetch(`${base}/api/collections.get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect(notJson.status).toBe(400);

    const noRoute = await fetch(`${base}/api/does.not.exist`, { method: 'POST' });
    expect(noRoute.status).toBe(404);

    const noAsset = await fetch(`${base}/assets/zzzzzz`);
    expect(noAsset.status).toBe(404);
  });

  it('accepts multipart uploads and reports a missing original as a storage error', async () => {
    app = await bootApp();
    const base = await app.listen(0);
    const form = new FormData();
    form.append('file', new Blob([await pngBytes(7, 9)], { type: 'image/png' }), 'x.png');
    form.append('label', 'multipart');
    const res = await fetch(`${base}/api/assets.upload`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const { asset } = (await res.json()) as Json;
    expect(asset).toMatchObject({ width: 7, height: 9, label: 'multipart', mime: 'image/png' });

    const { unlinkSync } = await import('node:fs');
    unlinkSync(app.store.originalPath(asset.id, 'png'));
    const gone = await fetch(`${base}/assets/${asset.id}`);
    expect(gone.status).toBe(500);
    expect(((await gone.json()) as Json).error.code).toBe('storage');
  });

  it('streams events over SSE, filtered by collection', async () => {
    app = await bootApp();
    const base = await app.listen(0);
    await post(base, 'collections.create', { slug: 'other', status: 'paused' });

    const controller = new AbortController();
    const res = await fetch(`${base}/api/events?collection=sse`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (pred: (s: string) => boolean) => {
      await until(
        async () => {
          if (pred(buffer)) return true;
          const { value, done } = await Promise.race([reader.read(), new Promise<{ value?: Uint8Array; done: boolean }>((r) => setTimeout(() => r({ done: false }), 50))]);
          if (done) return pred(buffer);
          if (value) buffer += decoder.decode(value, { stream: true });
          return pred(buffer);
        },
        { timeoutMs: 5000, what: 'sse event' },
      );
    };
    await readUntil((s) => s.includes('event: hello'));
    expect(buffer).toContain(`"bootId":"${app.bus.bootId}"`);

    await post(base, 'rows.add', { collection: 'other', rows: [{ prompt: 'filtered out' }] });
    await post(base, 'collections.create', { slug: 'sse', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'streamed' }] });
    await readUntil((s) => s.includes('event: collection.created'));
    await readUntil((s) => s.includes('"status":"succeeded"'));
    expect(buffer).not.toContain('"collection":"other"');
    expect(buffer).toContain('event: generation.updated');
    expect(buffer).toContain('event: asset.created');
    const cursorLine = buffer.split('\n').find((l) => l.startsWith('data: ') && l.includes('collection.created'))!;
    expect(JSON.parse(cursorLine.slice(6)).cursor).toMatch(new RegExp(`^${app.bus.bootId}\\.\\d+$`));
    controller.abort();
    await reader.cancel().catch(() => {});
  });
});
