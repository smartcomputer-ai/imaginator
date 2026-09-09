import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { App } from '../src/app.js';
import { mockProvider } from '../src/providers/mock.js';
import { pngBase64 } from './fixtures.js';
import { bootApp, cell, generateCalls, genRows, run, settle, statusMap, mockControl } from './helpers.js';

let app: App;
afterEach(async () => {
  await app?.stop();
});

describe('reconciliation', () => {
  it('fills every cell of a live collection and a duplicate command is a no-op', async () => {
    app = await bootApp();
    const created = await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/fast' }, { model: 'mock/text-only' }],
      rows: [{ prompt: 'one' }, { prompt: 'two' }],
    });
    expect(created.columns.map((c) => c.id)).toEqual(['fast', 'text-only']);
    expect(created.rows.map((r) => r.id)).toEqual(['r1', 'r2']);
    const view = await settle(app, 'c');
    expect(Object.values(statusMap(view)).every((s) => s === 'succeeded')).toBe(true);
    expect(view.cells.every((c) => c.outputs.length === 1 && c.versions === 1)).toBe(true);
    const before = genRows(app, 'c').map((g) => g.id);

    // Same content again: same hash, nothing new.
    await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'one' });
    await run(app, 'collections.update', { collection: 'c', defaults: {} });
    await run(app, 'columns.update', { collection: 'c', column: 'fast', count: 1 });
    const after = await settle(app, 'c');
    expect(genRows(app, 'c').map((g) => g.id)).toEqual(before);
    expect(after.cells.every((c) => c.versions === 1)).toBe(true);
    expect(generateCalls()).toHaveLength(4);
  });

  it('row-only and column-only invalidation', async () => {
    app = await bootApp();
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/fast' }, { model: 'mock/text-only' }],
      rows: [{ prompt: 'one' }, { prompt: 'two' }],
    });
    const v1 = await settle(app, 'c');
    const gen = (row: string, col: string) => cell(v1, row, col).generation;

    await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'one edited' });
    const v2 = await settle(app, 'c');
    expect(cell(v2, 'r1', 'fast').generation).not.toBe(gen('r1', 'fast'));
    expect(cell(v2, 'r1', 'text-only').generation).not.toBe(gen('r1', 'text-only'));
    expect(cell(v2, 'r2', 'fast').generation).toBe(gen('r2', 'fast'));
    expect(cell(v2, 'r2', 'text-only').generation).toBe(gen('r2', 'text-only'));
    expect(cell(v2, 'r1', 'fast').versions).toBe(2);
    expect(cell(v2, 'r1', 'fast').version).toBe(2);

    await run(app, 'columns.update', { collection: 'c', column: 'fast', settings: { hue: 120 } });
    const v3 = await settle(app, 'c');
    expect(cell(v3, 'r1', 'fast').generation).not.toBe(cell(v2, 'r1', 'fast').generation);
    expect(cell(v3, 'r2', 'fast').generation).not.toBe(cell(v2, 'r2', 'fast').generation);
    expect(cell(v3, 'r1', 'text-only').generation).toBe(cell(v2, 'r1', 'text-only').generation);
    expect(cell(v3, 'r2', 'text-only').generation).toBe(cell(v2, 'r2', 'text-only').generation);
    expect(Object.values(statusMap(v3)).every((s) => s === 'succeeded')).toBe(true);
  });

  it('setting a common key the model ignores is not an edit', async () => {
    app = await bootApp();
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/text-only' }], rows: [{ prompt: 'one' }] });
    const v1 = await settle(app, 'c');
    await run(app, 'rows.update', { collection: 'c', row: 'r1', settings: { aspectRatio: '16:9' } });
    const v2 = await settle(app, 'c');
    expect(cell(v2, 'r1', 'text-only').generation).toBe(cell(v1, 'r1', 'text-only').generation);
    expect(cell(v2, 'r1', 'text-only').droppedKeys).toEqual(['aspectRatio']);
  });

  it('pause, edit several things, resume → one wave', async () => {
    app = await bootApp();
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/fast' }],
      rows: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }],
    });
    await settle(app, 'c');
    const countBefore = genRows(app, 'c').length;

    const queuedEvents: string[] = [];
    app.bus.on((e) => {
      if (e.type === 'generation.updated' && e.status === 'queued') queuedEvents.push(e.id);
    });

    await run(app, 'collections.pause', { collection: 'c' });
    await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'a2' });
    await run(app, 'rows.update', { collection: 'c', row: 'r2', prompt: 'b2' });
    await run(app, 'columns.add', { collection: 'c', model: 'mock/text-only' });
    await run(app, 'rows.add', { collection: 'c', rows: [{ prompt: 'd' }] });
    const paused = await settle(app, 'c');
    expect(paused.status).toBe('paused');
    expect(genRows(app, 'c').length).toBe(countBefore);
    expect(queuedEvents).toHaveLength(0);
    expect(cell(paused, 'r1', 'fast').status).toBe('missing');
    expect(cell(paused, 'r3', 'fast').status).toBe('succeeded');

    await run(app, 'collections.resume', { collection: 'c' });
    const resumed = await settle(app, 'c');
    // r1/fast, r2/fast, r4/fast, and 4 × text-only = 7 new generations, each inserted exactly once.
    expect(queuedEvents).toHaveLength(7);
    expect(new Set(queuedEvents).size).toBe(7);
    expect(Object.values(statusMap(resumed)).every((s) => s === 'succeeded')).toBe(true);
    expect(genRows(app, 'c').length).toBe(countBefore + 7);
  });

  it('paused rows generate nothing until resumed; queued work of a paused row is cancelled', async () => {
    app = await bootApp();
    const unhold = mockControl.hold('start');
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'p1', paused: true }, { prompt: 'p2' }] });
    await mockControl.waitForHeld(1, 'p2');
    let view = app.services.collections.get('c');
    expect(cell(view, 'r1', 'fast').status).toBe('missing');
    expect(cell(view, 'r2', 'fast').status).toBe('submitting');
    mockControl.release();
    unhold();
    await settle(app, 'c');

    // Add a row while holding submissions so it stays queued; pause it → cancelled.
    const config = app.config;
    config.globalConcurrency = 0;
    await run(app, 'rows.add', { collection: 'c', rows: [{ prompt: 'p3' }] });
    await app.reconciler.settled('c');
    view = app.services.collections.get('c');
    expect(cell(view, 'r3', 'fast').status).toBe('queued');
    await run(app, 'rows.pause', { collection: 'c', rows: ['r3'] });
    await app.reconciler.settled('c');
    view = app.services.collections.get('c');
    expect(cell(view, 'r3', 'fast').status).toBe('missing');
    expect(genRows(app, 'c', 'r3').map((g) => g.status)).toEqual(['cancelled']);

    config.globalConcurrency = 8;
    await run(app, 'rows.resume', { collection: 'c', rows: ['r1', 'r3'] });
    view = await settle(app, 'c');
    expect(Object.values(statusMap(view)).every((s) => s === 'succeeded')).toBe(true);
  });

  it('revert after regenerate finds the old hash with no new run', async () => {
    app = await bootApp();
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'orig' }] });
    const v1 = await settle(app, 'c');
    const g1 = cell(v1, 'r1', 'fast').generation!;

    const regen = await run(app, 'cells.regenerate', { cell: 'c/r1/fast' });
    expect(regen.generation.forced).toBe(true);
    expect(regen.generation.requestHash).toBe(cell(v1, 'r1', 'fast').hash);
    const v2 = await settle(app, 'c');
    const g2 = cell(v2, 'r1', 'fast').generation!;
    expect(g2).not.toBe(g1);
    expect(cell(v2, 'r1', 'fast').version).toBe(2);

    await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'changed' });
    const v3 = await settle(app, 'c');
    expect(cell(v3, 'r1', 'fast').version).toBe(3);

    await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'orig' });
    const v4 = await settle(app, 'c');
    expect(cell(v4, 'r1', 'fast').generation).toBe(g2);
    expect(cell(v4, 'r1', 'fast').versions).toBe(3);
    expect(generateCalls('orig')).toHaveLength(2);
    expect(generateCalls('changed')).toHaveLength(1);

    const history = await run(app, 'cells.get', { cell: 'c/r1/fast' });
    expect(history.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(history.current?.id).toBe(g2);
    const byAddress = await run(app, 'generations.get', { generation: 'c/r1/fast#1' });
    expect(byAddress.generation.id).toBe(g1);
  });

  it('registry default change (and version bump) causes no new run', async () => {
    const dir = (await bootApp()).config.dataDir;
    await app?.stop();
    app = await bootApp({ dataDir: dir });
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'x' }] });
    const v1 = await settle(app, 'c');
    expect(cell(v1, 'r1', 'fast').status).toBe('succeeded');
    await app.stop();

    const patched = {
      ...mockProvider,
      models: mockProvider.models.map((m) =>
        m.id === 'mock/fast' ? { ...m, settings: z.object({ hue: z.number().optional(), delayMs: z.number().int().default(1234) }) } : m,
      ),
    };
    app = await bootApp({ dataDir: dir, deps: { providers: [patched], registryVersion: 'v-next' }, resetMock: false });
    const v2 = await settle(app, 'c');
    expect(cell(v2, 'r1', 'fast').generation).toBe(cell(v1, 'r1', 'fast').generation);
    expect(genRows(app, 'c')).toHaveLength(1);
    expect(generateCalls('x')).toHaveLength(1);

    // A genuinely new cell records the new defaults and version in its snapshot.
    await run(app, 'rows.add', { collection: 'c', rows: [{ prompt: 'y' }] });
    await settle(app, 'c');
    const g = genRows(app, 'c', 'r2')[0]!;
    expect(g.request.settings).toEqual({ delayMs: 1234 });
    expect(g.request.registryVersion).toBe('v-next');
  });

  it('invalid input/mask combinations make no provider call', async () => {
    app = await bootApp();
    const png = await run(app, 'assets.upload', { bytes: await pngBase64(8, 8), label: 'dot' });
    const big = await run(app, 'assets.upload', { bytes: await pngBase64(16, 16) });
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/fast' }, { model: 'mock/img2img' }, { model: 'mock/text-only', count: 2 }],
      rows: [
        { prompt: 'init on text-only', inputs: [{ asset: png.asset.id, role: 'init' }] },
        { prompt: 'mask size mismatch', inputs: [{ asset: png.asset.id, role: 'init' }, { asset: big.asset.id, role: 'mask', maskFor: 0 }] },
        { prompt: 'negative on text-only', negativePrompt: 'blur' },
      ],
    });
    const view = await settle(app, 'c');
    const s = statusMap(view);
    expect(s['r1/fast']).toBe('unsupported');
    expect(cell(view, 'r1', 'fast').error?.message).toMatch(/text-only/);
    expect(s['r1/img2img']).toBe('succeeded');
    expect(s['r1/text-only']).toBe('unsupported'); // count 2 > max 1, and an init input
    expect(s['r2/fast']).toBe('unsupported');
    expect(s['r2/img2img']).toBe('unsupported');
    expect(cell(view, 'r2', 'img2img').error?.message).toMatch(/must match its init image/);
    expect(s['r3/fast']).toBe('unsupported');
    expect(cell(view, 'r3', 'fast').error?.message).toMatch(/negative prompt/);
    expect(s['r3/img2img']).toBe('succeeded');
    expect(generateCalls().map((c) => c.prompt).sort()).toEqual(['init on text-only', 'negative on text-only']);

    // Retry re-resolves: fix the row and the cell runs.
    await run(app, 'rows.update', { collection: 'c', row: 'r3', negativePrompt: null });
    const fixed = await settle(app, 'c');
    expect(cell(fixed, 'r3', 'fast').status).toBe('succeeded');
  });

  it('removing rows and columns deletes their generations but keeps assets; delete cascades', async () => {
    app = await bootApp();
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }, { model: 'mock/text-only' }], rows: [{ prompt: 'a' }, { prompt: 'b' }] });
    const v = await settle(app, 'c');
    const asset = cell(v, 'r1', 'fast').outputs[0]!;
    await run(app, 'rows.remove', { collection: 'c', rows: ['r1'] });
    await run(app, 'columns.remove', { collection: 'c', column: 'text-only' });
    await settle(app, 'c');
    expect(genRows(app, 'c').map((g) => `${g.row}/${g.column}`)).toEqual(['r2/fast']);
    expect((await run(app, 'assets.get', { asset })).asset.id).toBe(asset);
    // Row ids are never reused.
    const added = await run(app, 'rows.add', { collection: 'c', rows: [{ prompt: 'c' }] });
    expect(added.rows[0]!.id).toBe('r3');
    await run(app, 'collections.delete', { collection: 'c' });
    expect(genRows(app, 'c')).toHaveLength(0);
    expect((await run(app, 'collections.list', {})).collections).toHaveLength(0);
    expect((await run(app, 'assets.get', { asset })).asset.id).toBe(asset);
  });

  it('rename rewrites references; duplicate copies structure paused; export/import round-trips', async () => {
    app = await bootApp();
    await run(app, 'collections.create', { slug: 'old', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'a' }] });
    await settle(app, 'old');
    const renamed = await run(app, 'collections.rename', { collection: 'old', slug: 'new' });
    expect(renamed.slug).toBe('new');
    expect(cell(renamed, 'r1', 'fast').status).toBe('succeeded');
    expect(genRows(app, 'new')).toHaveLength(1);
    await settle(app, 'new');
    expect(genRows(app, 'new')).toHaveLength(1);

    const dup = await run(app, 'collections.duplicate', { collection: 'new', slug: 'copy' });
    expect(dup.status).toBe('paused');
    expect(dup.rows.map((r) => r.prompt)).toEqual(['a']);
    expect(cell(dup, 'r1', 'fast').status).toBe('missing');

    const { document } = await run(app, 'collections.export', { collection: 'new' });
    const imported = await run(app, 'collections.import', { document, slug: 'imported', status: 'paused' });
    expect(imported.columns.map((c) => c.model)).toEqual(['mock/fast']);
    expect(imported.rows.map((r) => r.id)).toEqual(['r1']);
  });
});
