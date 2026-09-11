import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { bootApp, cell, generateCalls, genRows, mockControl, run, settle, until } from './helpers.js';

let app: App;
afterEach(async () => {
  await app?.stop();
});

const columns = [{ model: 'mock/img2img' }, { model: 'mock/text-only' }];

describe('row references (follow-up edits)', () => {
  it('a follow-up row runs after its base, on the base output of the same column', async () => {
    app = await bootApp();
    await run(app, 'collections.create', {
      slug: 'c',
      columns,
      rows: [{ prompt: 'a cat' }, { prompt: 'add a hat', inputs: [{ row: 'r1', role: 'init' }] }],
    });
    const v = await settle(app, 'c');
    const base = cell(v, 'r1', 'img2img');
    const follow = cell(v, 'r2', 'img2img');
    expect(base.status).toBe('succeeded');
    expect(follow.status).toBe('succeeded');
    const followGen = genRows(app, 'c', 'r2', 'img2img').find((g) => g.id === follow.generation)!;
    expect(followGen.request.inputs).toEqual([{ asset: base.outputs[0], role: 'init' }]);
    // The text-only column cannot take an init image: unsupported, no call made.
    expect(cell(v, 'r2', 'text-only').status).toBe('unsupported');
    expect(generateCalls()).toHaveLength(3);
    // The follow-up started only after the base finished.
    const order = mockControl.calls.filter((c) => c.type === 'generate').map((c) => c.prompt);
    expect(order.indexOf('add a hat')).toBeGreaterThan(order.indexOf('a cat'));
  });

  it('regenerating the base cascades down the chain in that column only', async () => {
    app = await bootApp();
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/img2img' }, { model: 'mock/img2img', id: 'other' }],
      rows: [
        { prompt: 'a cat' },
        { prompt: 'add a hat', inputs: [{ row: 'r1', role: 'init' }] },
        { prompt: 'make it red', inputs: [{ row: 'r2', role: 'init' }] },
      ],
    });
    const v1 = await settle(app, 'c');
    expect(v1.cells.every((c) => c.status === 'succeeded')).toBe(true);

    await run(app, 'cells.regenerate', { cell: 'c/r1/img2img' });
    const v2 = await settle(app, 'c');
    expect(cell(v2, 'r1', 'img2img').version).toBe(2);
    expect(cell(v2, 'r2', 'img2img').version).toBe(2);
    expect(cell(v2, 'r3', 'img2img').version).toBe(2);
    expect(cell(v2, 'r1', 'other').version).toBe(1);
    expect(cell(v2, 'r2', 'other').version).toBe(1);
    expect(cell(v2, 'r3', 'other').version).toBe(1);
    // Each step consumed the new output of the step above.
    const r2 = genRows(app, 'c', 'r2', 'img2img').find((g) => g.id === cell(v2, 'r2', 'img2img').generation)!;
    expect(r2.request.inputs[0]?.asset).toBe(cell(v2, 'r1', 'img2img').outputs[0]);
    const r3 = genRows(app, 'c', 'r3', 'img2img').find((g) => g.id === cell(v2, 'r3', 'img2img').generation)!;
    expect(r3.request.inputs[0]?.asset).toBe(cell(v2, 'r2', 'img2img').outputs[0]);
    // Old versions are history, not deleted.
    expect(cell(v2, 'r2', 'img2img').versions).toBe(2);
    expect(generateCalls()).toHaveLength(9);
  });

  it('editing the base reruns follow-ups; reverting finds the old chain without new runs', async () => {
    app = await bootApp();
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/img2img' }],
      rows: [{ prompt: 'a cat' }, { prompt: 'add a hat', inputs: [{ row: 'r1', role: 'init' }] }],
    });
    const v1 = await settle(app, 'c');
    await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'a dog' });
    const v2 = await settle(app, 'c');
    expect(cell(v2, 'r1', 'img2img').generation).not.toBe(cell(v1, 'r1', 'img2img').generation);
    expect(cell(v2, 'r2', 'img2img').generation).not.toBe(cell(v1, 'r2', 'img2img').generation);
    expect(generateCalls()).toHaveLength(4);

    await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'a cat' });
    const v3 = await settle(app, 'c');
    expect(cell(v3, 'r1', 'img2img').generation).toBe(cell(v1, 'r1', 'img2img').generation);
    expect(cell(v3, 'r2', 'img2img').generation).toBe(cell(v1, 'r2', 'img2img').generation);
    expect(generateCalls()).toHaveLength(4);
  });

  it('a follow-up is blocked while its base is missing, failed, or paused, and fills once it succeeds', async () => {
    app = await bootApp();
    mockControl.failNext({ match: 'a cat', message: 'boom' });
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/img2img' }],
      rows: [{ prompt: 'a cat' }, { prompt: 'add a hat', inputs: [{ row: 'r1', role: 'init' }] }],
    });
    const v1 = await settle(app, 'c');
    expect(cell(v1, 'r1', 'img2img').status).toBe('failed');
    expect(cell(v1, 'r2', 'img2img').status).toBe('blocked');
    expect(cell(v1, 'r2', 'img2img').blocked).toBe('r1/img2img cannot produce an output (failed); see that cell');
    expect(genRows(app, 'c', 'r2')).toHaveLength(0);
    await expect(run(app, 'cells.regenerate', { cell: 'c/r2/img2img' })).rejects.toThrow(/blocked/);

    await run(app, 'cells.retry', { cell: 'c/r1/img2img' });
    const v2 = await settle(app, 'c');
    expect(cell(v2, 'r1', 'img2img').status).toBe('succeeded');
    expect(cell(v2, 'r2', 'img2img').status).toBe('succeeded');

    await run(app, 'rows.pause', { collection: 'c', rows: ['r1'] });
    await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'a paused cat' });
    const v3 = await settle(app, 'c');
    expect(cell(v3, 'r1', 'img2img').status).toBe('missing');
    expect(cell(v3, 'r2', 'img2img').status).toBe('blocked');
    expect(cell(v3, 'r2', 'img2img').blocked).toBe('r1/img2img is paused and needs generation');
    await run(app, 'rows.resume', { collection: 'c', rows: ['r1'] });
    const v4 = await settle(app, 'c');
    expect(cell(v4, 'r2', 'img2img').status).toBe('succeeded');
  });

  it('a queued follow-up is superseded when its base changes mid-flight', async () => {
    app = await bootApp();
    const release = mockControl.hold('running', 'add a hat');
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/img2img' }],
      rows: [{ prompt: 'a cat' }, { prompt: 'add a hat', inputs: [{ row: 'r1', role: 'init' }] }],
    });
    await until(() => genRows(app, 'c', 'r2').some((g) => g.status !== 'queued'), { what: 'follow-up to start' });
    const first = genRows(app, 'c', 'r2')[0]!;
    await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'a dog' });
    release();
    const v = await settle(app, 'c');
    expect(cell(v, 'r2', 'img2img').status).toBe('succeeded');
    expect(cell(v, 'r2', 'img2img').generation).not.toBe(first.id);
    const current = genRows(app, 'c', 'r2').find((g) => g.id === cell(v, 'r2', 'img2img').generation)!;
    expect(current.request.inputs[0]?.asset).toBe(cell(v, 'r1', 'img2img').outputs[0]);
  });

  it('references are validated: unknown, self, cycle, and removal of a referenced row', async () => {
    app = await bootApp();
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/img2img' }], rows: [{ prompt: 'a cat' }, { prompt: 'b' }] });
    await expect(run(app, 'rows.add', { collection: 'c', rows: [{ prompt: 'x', inputs: [{ row: 'r9', role: 'init' }] }] })).rejects.toThrow(/r9 not found/);
    await expect(run(app, 'rows.update', { collection: 'c', row: 'r1', inputs: [{ row: 'r1', role: 'init' }] })).rejects.toThrow(/itself/);
    await run(app, 'rows.update', { collection: 'c', row: 'r2', inputs: [{ row: 'r1', role: 'init' }] });
    await expect(run(app, 'rows.update', { collection: 'c', row: 'r1', inputs: [{ row: 'r2', role: 'init' }] })).rejects.toThrow(/reference cycle/);
    await expect(run(app, 'rows.remove', { collection: 'c', rows: ['r1'] })).rejects.toThrow(/referenced by c\/r2/);
    // Removing both at once is fine.
    await run(app, 'rows.remove', { collection: 'c', rows: ['r1', 'r2'] });
    // A batch may reference rows within itself.
    await expect(
      run(app, 'rows.add', { collection: 'c', rows: [{ prompt: 'base' }, { prompt: 'edit', inputs: [{ row: 'r3', role: 'init' }] }] }),
    ).resolves.toMatchObject({ rows: [{ id: 'r3' }, { id: 'r4' }] });
    await settle(app, 'c');
  });

  it('export/import and duplicate keep references; gc ignores them', async () => {
    app = await bootApp();
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/img2img' }],
      rows: [{ prompt: 'a cat' }, { prompt: 'add a hat', inputs: [{ row: 'r1', role: 'init' }] }],
    });
    await settle(app, 'c');
    const { document } = await run(app, 'collections.export', { collection: 'c' });
    expect(document.assets).toEqual([]);
    const imported = await run(app, 'collections.import', { document, slug: 'd', status: 'paused' });
    expect(imported.rows[1]?.inputs).toEqual([{ row: 'r1', role: 'init' }]);
    const dup = await run(app, 'rows.duplicate', { collection: 'c', row: 'r2' });
    expect(dup.row.inputs).toEqual([{ row: 'r1', role: 'init' }]);
    const gc = await run(app, 'assets.gc', { dryRun: true });
    expect(gc.removed).toEqual([]);
  });
});
