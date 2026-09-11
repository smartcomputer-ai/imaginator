import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { bootApp, cell, generateCalls, genRows, mockControl, run, settle, until } from './helpers.js';

let app: App;
afterEach(async () => {
  await app?.stop();
});

const base = (slug: string, extraRows: Parameters<typeof run<'collections.create'>>[2]['rows'] = []) =>
  run(app, 'collections.create', {
    slug,
    columns: [{ model: 'mock/img2img' }, { model: 'mock/img2img', id: 'other' }],
    rows: [{ prompt: 'a cat' }, { prompt: 'add a hat', inputs: [{ row: 'r1', role: 'init' }] }, ...extraRows],
  });

describe('selection: current success versus latest attempt', () => {
  it('a failed regenerate keeps the previous success current and the chain intact', async () => {
    app = await bootApp();
    await base('c');
    const v1 = await settle(app, 'c');
    const baseGen = cell(v1, 'r1', 'img2img').generation;
    const followGen = cell(v1, 'r2', 'img2img').generation;

    mockControl.failNext({ match: 'a cat', message: 'boom' });
    await run(app, 'cells.regenerate', { cell: 'c/r1/img2img' });
    const v2 = await settle(app, 'c');
    const c = cell(v2, 'r1', 'img2img');
    expect(c.status).toBe('failed');
    expect(c.generation).toBe(baseGen);
    expect(c.latest?.status).toBe('failed');
    expect(c.error?.message).toBe('boom');
    expect(c.outputs).toHaveLength(1);
    expect(c.stale).toBeUndefined();
    // Dependents kept the existing output; nothing downstream reran.
    expect(cell(v2, 'r2', 'img2img').generation).toBe(followGen);
    expect(v2.progress.state).toBe('settled');
    expect(v2.progress.failedAttempts).toEqual([{ cell: 'c/r1/img2img', message: 'boom' }]);
    expect(v2.progress.allSucceeded).toBe(true);

    // Retry targets the failed attempt even though a success is current.
    await run(app, 'cells.retry', { cell: 'c/r1/img2img' });
    const v3 = await settle(app, 'c');
    expect(cell(v3, 'r1', 'img2img').status).toBe('succeeded');
    expect(cell(v3, 'r1', 'img2img').generation).not.toBe(baseGen);
    expect(cell(v3, 'r2', 'img2img').generation).not.toBe(followGen);
  });

  it('changed content shows the old image as stale and dependents block until a new success exists', async () => {
    app = await bootApp();
    await base('c');
    await settle(app, 'c');
    await run(app, 'collections.pause', { collection: 'c' });
    await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'a dog' });
    const v = await settle(app, 'c');
    const c = cell(v, 'r1', 'img2img');
    expect(c.status).toBe('missing');
    expect(c.generation).toBeUndefined();
    expect(c.stale).toBe(true);
    expect(c.outputs).toHaveLength(1);
    expect(cell(v, 'r2', 'img2img').status).toBe('blocked');
    expect(cell(v, 'r2', 'img2img').blocked).toBe('r1/img2img is paused and needs generation');
    expect(v.progress.state).toBe('blocked');
    expect(v.progress.blocked[0]).toMatchObject({ cell: 'c/r2/img2img', pending: false });
  });

  it('pausing a source with a valid output keeps dependents usable', async () => {
    app = await bootApp();
    await base('c');
    await settle(app, 'c');
    await run(app, 'rows.pause', { collection: 'c', rows: ['r1'] });
    await run(app, 'rows.update', { collection: 'c', row: 'r2', prompt: 'add a scarf' });
    const v = await settle(app, 'c');
    expect(cell(v, 'r2', 'img2img').status).toBe('succeeded');
    expect(genRows(app, 'c', 'r2', 'img2img').filter((g) => g.status === 'succeeded')).toHaveLength(2);
  });
});

describe('pins', () => {
  it('a pin holds dependents still across regenerates, goes inactive on edit, and applies again on revert', async () => {
    app = await bootApp();
    await base('c');
    const v1 = await settle(app, 'c');
    const followGen = cell(v1, 'r2', 'img2img').generation;

    const pinned = await run(app, 'cells.pin', { cell: 'c/r1/img2img' });
    expect(pinned.cell.pin).toMatchObject({ version: 1, active: true });
    await run(app, 'cells.regenerate', { cell: 'c/r1/img2img' });
    await run(app, 'cells.regenerate', { cell: 'c/r1/img2img' });
    const v2 = await settle(app, 'c');
    expect(cell(v2, 'r1', 'img2img').versions).toBe(3);
    expect(cell(v2, 'r1', 'img2img').version).toBe(1);
    expect(cell(v2, 'r2', 'img2img').generation).toBe(followGen);
    expect(cell(v2, 'r2', 'img2img').versions).toBe(1);

    // Pin the newest sample: the chain reruns once.
    await run(app, 'cells.pin', { cell: 'c/r1/img2img', version: 3 });
    const v3 = await settle(app, 'c');
    expect(cell(v3, 'r1', 'img2img').version).toBe(3);
    expect(cell(v3, 'r2', 'img2img').generation).not.toBe(followGen);
    expect(cell(v3, 'r2', 'img2img').versions).toBe(2);

    // Only a matching success can be pinned.
    await expect(run(app, 'cells.pin', { cell: 'c/r1/img2img', version: 9 })).rejects.toThrow(/not found/);

    // Editing the content leaves the pin inactive; reverting applies it again.
    await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'a dog' });
    const v4 = await settle(app, 'c');
    expect(cell(v4, 'r1', 'img2img').pin).toMatchObject({ version: 3, active: false });
    expect(cell(v4, 'r1', 'img2img').version).toBe(4);
    await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'a cat' });
    const v5 = await settle(app, 'c');
    expect(cell(v5, 'r1', 'img2img').pin).toMatchObject({ version: 3, active: true });
    expect(cell(v5, 'r1', 'img2img').version).toBe(3);

    // Unpin selects the newest matching success.
    await run(app, 'cells.unpin', { cell: 'c/r1/img2img' });
    const v6 = await settle(app, 'c');
    expect(cell(v6, 'r1', 'img2img').pin).toBeUndefined();
    expect(cell(v6, 'r1', 'img2img').version).toBe(3);
  });

  it('regenerate with holdCurrent pins first, atomically; a downstream pin is not a barrier', async () => {
    app = await bootApp();
    await base('c', [{ prompt: 'make it red', inputs: [{ row: 'r2', role: 'init' }] }]);
    const v1 = await settle(app, 'c');
    await run(app, 'cells.pin', { cell: 'c/r3/img2img' });
    await run(app, 'cells.regenerate', { cell: 'c/r1/img2img', holdCurrent: true });
    const v2 = await settle(app, 'c');
    expect(cell(v2, 'r1', 'img2img').pin).toMatchObject({ version: 1, active: true });
    expect(cell(v2, 'r1', 'img2img').versions).toBe(2);
    expect(cell(v2, 'r2', 'img2img').generation).toBe(cell(v1, 'r2', 'img2img').generation);
    const impact = await run(app, 'cells.impact', { cell: 'c/r1/img2img', action: 'unpin' });
    expect(impact.cells).toEqual(['c/r2/img2img', 'c/r3/img2img']);
    expect(impact.sourcePinned).toBe(true);
    expect(impact.pinned).toEqual(['c/r3/img2img']);
    // Unpin: the newest sample becomes current, r2 reruns, and r3's pin no longer matches its new input.
    await run(app, 'cells.unpin', { cell: 'c/r1/img2img' });
    const v3 = await settle(app, 'c');
    expect(cell(v3, 'r1', 'img2img').version).toBe(2);
    expect(cell(v3, 'r2', 'img2img').versions).toBe(2);
    expect(cell(v3, 'r3', 'img2img').versions).toBe(2);
    expect(cell(v3, 'r3', 'img2img').pin).toMatchObject({ active: false });
  });
});

describe('sparse rows and absolute references', () => {
  it('a skipped cell costs nothing and blocks its dependents with a reason', async () => {
    app = await bootApp();
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/img2img' }, { model: 'mock/img2img', id: 'other' }],
      rows: [
        { prompt: 'a cat', columns: ['img2img'] },
        { prompt: 'add a hat', inputs: [{ row: 'r1', role: 'init' }] },
      ],
    });
    const v = await settle(app, 'c');
    expect(cell(v, 'r1', 'img2img').status).toBe('succeeded');
    expect(cell(v, 'r1', 'other').status).toBe('skipped');
    expect(cell(v, 'r2', 'img2img').status).toBe('succeeded');
    expect(cell(v, 'r2', 'other')).toMatchObject({ status: 'blocked', blocked: 'r1/other is skipped' });
    expect(generateCalls()).toHaveLength(2);
    expect(v.progress.state).toBe('blocked');
    await expect(run(app, 'cells.regenerate', { cell: 'c/r1/other' })).rejects.toThrow(/skipped/);
    await expect(run(app, 'rows.update', { collection: 'c', row: 'r1', columns: ['nope'] })).rejects.toThrow(/not found/);
    // Widening the row runs the missing cell and unblocks r2/other.
    await run(app, 'rows.update', { collection: 'c', row: 'r1', columns: null });
    const v2 = await settle(app, 'c');
    expect(cell(v2, 'r2', 'other').status).toBe('succeeded');
    expect(v2.progress.allSucceeded).toBe(true);
  });

  it('an absolute reference feeds the same picture to every column; the string form is accepted', async () => {
    app = await bootApp();
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/img2img', id: 'flux' }, { model: 'mock/img2img', id: 'nano' }],
      rows: [{ prompt: 'a cat' }, { prompt: 'film grain', inputs: [{ ref: 'r1/flux', role: 'init' }] }],
    });
    const v = await settle(app, 'c');
    const fluxBase = cell(v, 'r1', 'flux').outputs[0];
    expect(v.rows[1]?.inputs).toEqual([{ row: 'r1', column: 'flux', role: 'init' }]);
    for (const col of ['flux', 'nano']) {
      const g = genRows(app, 'c', 'r2', col).find((x) => x.id === cell(v, 'r2', col).generation)!;
      expect(g.request.inputs[0]?.asset).toBe(fluxBase);
    }
    // Regenerating nano's base changes nothing in r2; regenerating flux's base reruns r2 in both columns.
    await run(app, 'cells.regenerate', { cell: 'c/r1/nano' });
    const v2 = await settle(app, 'c');
    expect(cell(v2, 'r2', 'flux').versions).toBe(1);
    expect(cell(v2, 'r2', 'nano').versions).toBe(1);
    await run(app, 'cells.regenerate', { cell: 'c/r1/flux' });
    const v3 = await settle(app, 'c');
    expect(cell(v3, 'r2', 'flux').versions).toBe(2);
    expect(cell(v3, 'r2', 'nano').versions).toBe(2);
    const got = await run(app, 'cells.get', { cell: 'c/r1/flux' });
    expect(got.dependents.sort()).toEqual(['c/r2/flux', 'c/r2/nano']);
    expect((await run(app, 'cells.get', { cell: 'c/r2/nano' })).precedents).toEqual(['c/r1/flux']);
    // A referenced column cannot be removed or renamed; a column only used by same-column follow-ups can.
    await expect(run(app, 'columns.remove', { collection: 'c', column: 'flux' })).rejects.toThrow(/referenced by/);
    await expect(run(app, 'columns.update', { collection: 'c', column: 'flux', id: 'flux2' })).rejects.toThrow(/referenced by/);
    await run(app, 'rows.add', { collection: 'c', rows: [{ prompt: 'follow-up', inputs: [{ row: 'r1', role: 'init' }] }] });
    await settle(app, 'c');
    await run(app, 'columns.remove', { collection: 'c', column: 'nano' });
    expect(app.services.collections.get('c').columns.map((c) => c.id)).toEqual(['flux']);
    // Likewise a row only referenced by a column recipe's same-row anchor can be removed.
    await run(app, 'columns.add', { collection: 'c', model: 'mock/edit', id: 'film', inputs: [{ column: 'flux', role: 'init' }], negativePrompt: '' });
    await settle(app, 'c');
    await run(app, 'rows.remove', { collection: 'c', rows: ['r3'] });
    expect(app.services.collections.get('c').rows.map((r) => r.id)).toEqual(['r1', 'r2']);
  });
});

describe('column recipes', () => {
  it('a stage column runs after its source in the same row, ignores row inputs, and re-applies to follow-ups', async () => {
    app = await bootApp();
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [
        { model: 'mock/img2img', id: 'flux' },
        { model: 'mock/edit', id: 'film', prompt: 'add film grain', negativePrompt: '', inputs: [{ column: 'flux', role: 'init' }] },
        { model: 'mock/edit', id: 'upscale', prompt: 'upscale', negativePrompt: '', inputs: [{ ref: 'film', role: 'init' }] },
      ],
      rows: [{ prompt: 'a cat', negativePrompt: 'text' }, { prompt: 'add a hat', inputs: [{ row: 'r1', role: 'init' }] }],
    });
    const v = await settle(app, 'c');
    expect(v.cells.every((c) => c.status === 'succeeded')).toBe(true);
    const gen = (row: string, col: string) => genRows(app, 'c', row, col).find((g) => g.id === cell(v, row, col).generation)!;
    expect(gen('r1', 'film').request.prompt).toBe('add film grain');
    expect(gen('r1', 'film').request.negativePrompt).toBeUndefined();
    expect(gen('r1', 'flux').request.negativePrompt).toBe('text');
    expect(gen('r1', 'film').request.inputs[0]?.asset).toBe(cell(v, 'r1', 'flux').outputs[0]);
    expect(gen('r1', 'upscale').request.inputs[0]?.asset).toBe(cell(v, 'r1', 'film').outputs[0]);
    // r2's row reference went into flux only; film took r2/flux, the edited base.
    expect(gen('r2', 'flux').request.inputs[0]?.asset).toBe(cell(v, 'r1', 'flux').outputs[0]);
    expect(gen('r2', 'film').request.inputs).toEqual([{ asset: cell(v, 'r2', 'flux').outputs[0], role: 'init' }]);
    const order = mockControl.calls.filter((c) => c.type === 'generate').map((c) => c.prompt);
    expect(order.indexOf('add film grain')).toBeGreaterThan(order.indexOf('a cat'));
    expect(order.indexOf('upscale')).toBeGreaterThan(order.indexOf('add film grain'));

    // Editing the template reruns only that column and its dependents.
    await run(app, 'columns.update', { collection: 'c', column: 'film', prompt: 'add heavy film grain' });
    const v2 = await settle(app, 'c');
    expect(cell(v2, 'r1', 'flux').versions).toBe(1);
    expect(cell(v2, 'r1', 'film').versions).toBe(2);
    expect(cell(v2, 'r1', 'upscale').versions).toBe(2);
    // A replacing column ignores row input edits.
    await run(app, 'rows.update', { collection: 'c', row: 'r1', inputs: [] });
    const v3 = await settle(app, 'c');
    expect(cell(v3, 'r1', 'film').versions).toBe(2);
    // Without the empty negative template the stage is unsupported: the row's negative prompt reaches a model that has none.
    await run(app, 'columns.update', { collection: 'c', column: 'film', negativePrompt: null });
    const v4 = await settle(app, 'c');
    expect(cell(v4, 'r1', 'film').status).toBe('unsupported');
    expect(v4.progress.state).toBe('blocked');
    expect(v4.progress.attention.unsupported[0]?.cell).toBe('c/r1/film');
    expect(cell(v4, 'r1', 'upscale').blocked).toBe('r1/film cannot produce an output (unsupported); see that cell');
  });

  it('a cell that is unsupported on its own terms reports that, not blocked, even with an unresolved reference', async () => {
    app = await bootApp();
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/edit', id: 'edit' }, { model: 'mock/text-only' }],
      rows: [{ prompt: 'a cat' }, { prompt: 'add a hat', inputs: [{ ref: 'r1/edit', role: 'init' }] }],
    });
    const v = await settle(app, 'c');
    // r1/edit is unsupported (no image), so r2's reference cannot resolve; but text-only could never take an init anyway.
    expect(cell(v, 'r1', 'edit').status).toBe('unsupported');
    expect(cell(v, 'r2', 'edit').blocked).toBe('r1/edit cannot produce an output (unsupported); see that cell');
    expect(cell(v, 'r2', 'text-only').status).toBe('unsupported');
    expect(cell(v, 'r2', 'text-only').error?.message).toMatch(/text-only and cannot take a init input/);
    expect(v.progress.state).toBe('blocked');
  });

  it('an edit-only model with no input is unsupported locally, never a provider call', async () => {
    app = await bootApp();
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/img2img', id: 'flux' }, { model: 'mock/edit', id: 'film', prompt: 'grain', negativePrompt: '', inputs: [] }, { model: 'mock/edit', id: 'plain' }],
      rows: [{ prompt: 'a cat' }],
    });
    const v = await settle(app, 'c');
    expect(cell(v, 'r1', 'film').status).toBe('unsupported');
    expect(cell(v, 'r1', 'film').error?.message).toMatch(/requires an input image/);
    expect(cell(v, 'r1', 'plain').status).toBe('unsupported');
    expect(generateCalls()).toHaveLength(1);
    await run(app, 'columns.update', { collection: 'c', column: 'film', inputs: [{ column: 'flux', role: 'init' }] });
    const v2 = await settle(app, 'c');
    expect(cell(v2, 'r1', 'film').status).toBe('succeeded');
  });

  it('recipe references are validated and cycles across recipes and rows are refused', async () => {
    app = await bootApp();
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/img2img', id: 'a' }, { model: 'mock/img2img', id: 'b' }], rows: [{ prompt: 'x' }] });
    await expect(run(app, 'columns.update', { collection: 'c', column: 'a', inputs: [{ column: 'a', role: 'init' }] })).rejects.toThrow(/itself/);
    await expect(run(app, 'columns.update', { collection: 'c', column: 'a', inputs: [{ column: 'zzz', role: 'init' }] })).rejects.toThrow(/not found/);
    await expect(run(app, 'columns.update', { collection: 'c', column: 'a', inputs: [{ row: 'r1', role: 'init' }] })).rejects.toThrow(/invalid input/);
    await run(app, 'columns.update', { collection: 'c', column: 'b', inputs: [{ column: 'a', role: 'init' }] });
    await expect(run(app, 'columns.update', { collection: 'c', column: 'a', inputs: [{ column: 'b', role: 'init' }] })).rejects.toThrow(/reference cycle/);
    // A row reference into the stage column plus the stage reading that row's source is fine; pointing it back is a cycle.
    await run(app, 'rows.add', { collection: 'c', rows: [{ prompt: 'y', inputs: [{ row: 'r1', column: 'b', role: 'init' }] }] });
    await expect(run(app, 'columns.update', { collection: 'c', column: 'a', inputs: [{ row: 'r2', column: 'b', role: 'init' }] })).rejects.toThrow(/reference cycle/);
    await settle(app, 'c');
  });
});

describe('cross-collection references', () => {
  it('an external reference follows the source collection and blocks while it is paused', async () => {
    app = await bootApp();
    await run(app, 'collections.create', { slug: 'structure', columns: [{ model: 'mock/img2img', id: 'flux' }], rows: [{ prompt: 'a cat' }] });
    await settle(app, 'structure');
    await run(app, 'collections.create', {
      slug: 'style',
      columns: [{ model: 'mock/edit', id: 'kontext' }],
      rows: [{ prompt: 'film grain', inputs: [{ ref: 'structure/r1/flux', role: 'init' }] }],
    });
    const v1 = await settle(app, 'style');
    expect(cell(v1, 'r1', 'kontext').status).toBe('succeeded');
    const src = genRows(app, 'style', 'r1', 'kontext')[0]!;
    expect(src.request.inputs[0]?.asset).toBe(cell(await settle(app, 'structure'), 'r1', 'flux').outputs[0]);
    expect(await run(app, 'collections.export', { collection: 'style' }).then((r) => r.document.dependencies)).toEqual(['structure']);

    // Regenerating upstream reruns the dependent collection, and waiting on it sees the upstream work.
    const cursor = app.services.collections.get('style').cursor;
    await run(app, 'cells.regenerate', { cell: 'structure/r1/flux' });
    const w = await run(app, 'collections.wait', { collection: 'style', cursor, timeoutMs: 5000 });
    expect(w.changed).toBe(true);
    const v2 = await settle(app, 'style');
    await settle(app, 'structure');
    const v3 = await settle(app, 'style');
    expect(cell(v3, 'r1', 'kontext').versions).toBe(2);
    void v2;

    // Pausing the source with an edit blocks the dependent; a paused source with a valid output does not.
    await run(app, 'collections.pause', { collection: 'structure' });
    const v4 = await settle(app, 'style');
    expect(cell(v4, 'r1', 'kontext').status).toBe('succeeded');
    await run(app, 'rows.update', { collection: 'structure', row: 'r1', prompt: 'a dog' });
    const v5 = await settle(app, 'style');
    expect(cell(v5, 'r1', 'kontext')).toMatchObject({ status: 'blocked', blocked: 'structure/r1/flux is paused and needs generation', stale: true });
    expect(v5.progress.state).toBe('blocked');
    await run(app, 'collections.resume', { collection: 'structure' });
    await settle(app, 'structure');
    const v6 = await settle(app, 'style');
    expect(cell(v6, 'r1', 'kontext').status).toBe('succeeded');
    expect(cell(v6, 'r1', 'kontext').versions).toBe(3);

    // Integrity: the source cannot be deleted while referenced; a rename keeps references working.
    await expect(run(app, 'collections.delete', { collection: 'structure' })).rejects.toThrow(/referenced by style\/r1/);
    await expect(run(app, 'rows.remove', { collection: 'structure', rows: ['r1'] })).rejects.toThrow(/referenced by style\/r1/);
    await run(app, 'collections.rename', { collection: 'structure', slug: 'base' });
    expect(app.services.collections.get('style').rows[0]?.inputs).toEqual([{ collection: 'base', row: 'r1', column: 'flux', role: 'init' }]);
    await run(app, 'cells.regenerate', { cell: 'base/r1/flux' });
    await settle(app, 'base');
    const v7 = await settle(app, 'style');
    expect(cell(v7, 'r1', 'kontext').versions).toBe(4);
    expect(app.services.collections.dependencies('base')).toEqual({ upstream: [], dependents: ['style'] });
  });

  it('a cross-collection cycle is refused and a collection-level cycle over an acyclic cell graph resolves', async () => {
    app = await bootApp();
    await run(app, 'collections.create', { slug: 'a', columns: [{ model: 'mock/img2img', id: 'm' }], rows: [{ prompt: 'a1' }, { prompt: 'a2' }] });
    await run(app, 'collections.create', { slug: 'b', columns: [{ model: 'mock/edit', id: 'm' }], rows: [{ prompt: 'b1', inputs: [{ ref: 'a/r1/m', role: 'init' }] }] });
    // a/r2 reads b/r1: a → b → a at the collection level, acyclic at the cell level.
    await run(app, 'rows.update', { collection: 'a', row: 'r2', inputs: [{ ref: 'b/r1/m', role: 'init' }] });
    await settle(app, 'a');
    await settle(app, 'b');
    const va = await settle(app, 'a');
    expect(cell(va, 'r2', 'm').status).toBe('succeeded');
    // Closing the loop at the cell level is refused.
    await expect(run(app, 'rows.update', { collection: 'a', row: 'r1', inputs: [{ ref: 'b/r1/m', role: 'init' }] })).rejects.toThrow(/reference cycle/);
    await expect(run(app, 'rows.add', { collection: 'b', rows: [{ prompt: 'x', inputs: [{ ref: 'nope/r1/m', role: 'init' }] }] })).rejects.toThrow(/collection nope not found/);
    // Reverting a change upstream restores the cached chain in both collections with no new runs.
    const calls = generateCalls().length;
    await run(app, 'rows.update', { collection: 'a', row: 'r1', prompt: 'a1 v2' });
    await settle(app, 'a');
    await settle(app, 'b');
    await settle(app, 'a');
    const after = generateCalls().length;
    expect(after).toBe(calls + 3);
    await run(app, 'rows.update', { collection: 'a', row: 'r1', prompt: 'a1' });
    await settle(app, 'a');
    await settle(app, 'b');
    const back = await settle(app, 'a');
    expect(generateCalls().length).toBe(after);
    expect(cell(back, 'r2', 'm').status).toBe('succeeded');
    expect(back.progress.allSucceeded).toBe(true);
  });
});

describe('progress and execution controls', () => {
  it('reports running while upstream works, blocked on an upstream failure, settled with attention lists', async () => {
    app = await bootApp();
    mockControl.hold('complete', 'a cat');
    await run(app, 'collections.create', {
      slug: 'a',
      columns: [{ model: 'mock/img2img', id: 'm', count: 9 }, { model: 'mock/text-only' }],
      rows: [{ prompt: 'a cat', negativePrompt: 'no text' }],
    });
    await run(app, 'collections.create', { slug: 'b', columns: [{ model: 'mock/edit', id: 'm' }], rows: [{ prompt: 'grain', inputs: [{ ref: 'a/r1/m', role: 'init' }] }] });
    await app.reconciler.settled('a');
    await app.reconciler.settled('b');
    // count 9 makes a/r1/m unsupported; the negative prompt makes text-only unsupported. b waits on nothing that can move.
    const va = await settle(app, 'a');
    expect(va.progress.state).toBe('settled');
    expect(va.progress.attention.unsupported.map((u) => u.cell).sort()).toEqual(['a/r1/m', 'a/r1/text-only']);
    expect(va.progress.allSucceeded).toBe(false);
    const vb = await settle(app, 'b');
    expect(vb.progress.state).toBe('blocked');
    expect(vb.progress.blocked[0]).toMatchObject({ cell: 'b/r1/m', pending: false });
    expect(vb.progress.blocked[0]?.reason).toBe('a/r1/m cannot produce an output (unsupported); see that cell');

    // Fix the source: b reports running (upstream in flight) while a's cell is held by the mock.
    await run(app, 'columns.update', { collection: 'a', column: 'm', count: 1 });
    await mockControl.waitForHeld(1, 'a cat');
    const running = app.services.collections.get('b');
    expect(running.progress.state).toBe('running');
    expect(running.progress.upstream.inFlight).toBe(1);
    expect(running.inFlight + running.queued).toBe(0);
    mockControl.release();
    await settle(app, 'a');
    const done = await settle(app, 'b');
    expect(done.progress.state).toBe('settled');
    expect(done.progress.allSucceeded).toBe(true);
    // A plain unsupported cell in the source collection settles with the cell listed, not blocked.
    const doneA = await settle(app, 'a');
    expect(doneA.progress.state).toBe('settled');
    expect(doneA.progress.attention.unsupported.map((u) => u.cell)).toEqual(['a/r1/text-only']);
  });

  it('queued work is revalidated at claim time: an edit during the debounce cannot submit obsolete work', async () => {
    app = await bootApp({ config: { reconcileDebounceMs: 300, globalConcurrency: 1 } });
    mockControl.hold('complete', 'first');
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'first' }, { prompt: 'second' }] });
    await mockControl.waitForHeld(1, 'first');
    // r2 is queued behind the concurrency cap. Edit it: for ~300ms the queued row still exists.
    await run(app, 'rows.update', { collection: 'c', row: 'r2', prompt: 'second v2' });
    mockControl.release();
    await until(() => genRows(app, 'c', 'r2').some((g) => g.status === 'cancelled'));
    const v = await settle(app, 'c');
    expect(generateCalls('second')).toHaveLength(0);
    expect(generateCalls('second v2')).toHaveLength(1);
    expect(cell(v, 'r2', 'fast').status).toBe('succeeded');
  });
});
