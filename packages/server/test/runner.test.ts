import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { bootApp, cell, generateCalls, genRows, mockControl, run, settle, sleep, statusMap, until } from './helpers.js';

let app: App;
afterEach(async () => {
  await app?.stop();
});

describe('runner', () => {
  it('out-of-order completions land in the right cells', async () => {
    app = await bootApp();
    mockControl.hold('complete');
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/fast' }],
      rows: [{ prompt: 'first' }, { prompt: 'second' }, { prompt: 'third' }],
    });
    await mockControl.waitForHeld(3);
    let view = app.services.collections.get('c');
    expect(Object.values(statusMap(view)).every((s) => s === 'submitting')).toBe(true);
    expect(view.inFlight).toBe(3);

    mockControl.release('third');
    await until(() => cell(app.services.collections.get('c'), 'r3', 'fast').status === 'succeeded');
    view = app.services.collections.get('c');
    expect(cell(view, 'r1', 'fast').status).toBe('submitting');
    expect(cell(view, 'r2', 'fast').status).toBe('submitting');

    mockControl.release('first');
    await until(() => cell(app.services.collections.get('c'), 'r1', 'fast').status === 'succeeded');
    mockControl.release('second');
    view = await settle(app, 'c');
    expect(Object.values(statusMap(view)).every((s) => s === 'succeeded')).toBe(true);
    // Each cell's asset came from its own generation.
    for (const c of view.cells) {
      const asset = await run(app, 'assets.get', { asset: c.outputs[0]! });
      expect(asset.asset.origin).toEqual({ type: 'generation', generation: c.generation });
    }
  });

  it('respects global and per-provider concurrency', async () => {
    app = await bootApp({ config: { globalConcurrency: 2 } });
    mockControl.hold('complete');
    await run(app, 'collections.create', {
      slug: 'c',
      columns: [{ model: 'mock/fast' }],
      rows: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }, { prompt: 'd' }],
    });
    await mockControl.waitForHeld(2);
    await sleep(50);
    expect(mockControl.heldCalls()).toHaveLength(2);
    let view = app.services.collections.get('c');
    expect(view.inFlight).toBe(2);
    expect(view.queued).toBe(2);
    mockControl.release('a');
    await mockControl.waitForHeld(2, (h) => h.prompt !== 'a');
    view = app.services.collections.get('c');
    expect(view.inFlight).toBe(2);
    expect(view.queued).toBe(1);
    mockControl.release();
    await until(() => mockControl.heldCalls().length > 0 || app.services.collections.get('c').inFlight === 0);
    mockControl.release();
    view = await settle(app, 'c');
    expect(Object.values(statusMap(view)).every((s) => s === 'succeeded')).toBe(true);
  });

  it('edits during active runs: superseded queued → cancelled at once', async () => {
    app = await bootApp({ config: { globalConcurrency: 1 } });
    mockControl.hold('complete');
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'running' }, { prompt: 'waiting' }] });
    await mockControl.waitForHeld(1, 'running');
    expect(cell(app.services.collections.get('c'), 'r2', 'fast').status).toBe('queued');
    const queuedId = cell(app.services.collections.get('c'), 'r2', 'fast').generation!;

    await run(app, 'rows.update', { collection: 'c', row: 'r2', prompt: 'waiting v2' });
    await app.reconciler.settled('c');
    const rows = genRows(app, 'c', 'r2');
    expect(rows.find((g) => g.id === queuedId)?.status).toBe('cancelled');
    expect(rows.filter((g) => g.status === 'queued')).toHaveLength(1);

    mockControl.release();
    await until(() => mockControl.heldCalls().length > 0);
    mockControl.release();
    const view = await settle(app, 'c');
    expect(Object.values(statusMap(view)).every((s) => s === 'succeeded')).toBe(true);
    expect(generateCalls('waiting')).toHaveLength(0);
    expect(cell(view, 'r2', 'fast').versions).toBe(1);
  });

  it('edits during active runs: confirmed cancel marks the superseded generation cancelled', async () => {
    app = await bootApp();
    mockControl.hold('running');
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/slow' }], rows: [{ prompt: 'slow one' }] });
    await mockControl.waitForHeld(1, 'slow one');
    const first = genRows(app, 'c')[0]!;
    expect(first.status).toBe('running');
    expect(first.providerRef).toBeTruthy();

    await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'slow two' });
    await until(() => genRows(app, 'c').find((g) => g.id === first.id)?.status === 'cancelled');
    expect(mockControl.calls.filter((c) => c.type === 'cancel')).toHaveLength(1);
    // The held call was aborted locally after confirmation.
    await until(() => mockControl.heldCalls().every((h) => h.prompt !== 'slow one'));
    await mockControl.waitForHeld(1, 'slow two');
    mockControl.release();
    const view = await settle(app, 'c');
    expect(cell(view, 'r1', 'slow').status).toBe('succeeded');
    expect(cell(view, 'r1', 'slow').versions).toBe(1);
  });

  it('edits during active runs: pending cancel keeps monitoring and the result becomes history', async () => {
    app = await bootApp();
    mockControl.cancelOutcome = 'pending';
    mockControl.hold('running');
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/slow' }], rows: [{ prompt: 'keep me' }] });
    await mockControl.waitForHeld(1, 'keep me');
    const first = genRows(app, 'c')[0]!;

    await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'replacement' });
    await until(() => mockControl.calls.some((c) => c.type === 'cancel'));
    await mockControl.waitForHeld(1, 'replacement');
    // Old one still running: completion wins.
    expect(genRows(app, 'c').find((g) => g.id === first.id)?.status).toBe('running');
    mockControl.release('keep me');
    await until(() => genRows(app, 'c').find((g) => g.id === first.id)?.status === 'succeeded');
    let view = app.services.collections.get('c');
    expect(cell(view, 'r1', 'slow').status).toBe('running');
    expect(cell(view, 'r1', 'slow').versions).toBe(2);
    mockControl.release('replacement');
    view = await settle(app, 'c');
    expect(cell(view, 'r1', 'slow').status).toBe('succeeded');
    expect(cell(view, 'r1', 'slow').generation).not.toBe(first.id);
    const history = await run(app, 'cells.get', { cell: 'c/r1/slow' });
    expect(history.versions.map((v) => v.status)).toEqual(['succeeded', 'succeeded']);
    expect(history.versions[1]!.outputs).toHaveLength(1);
  });

  it('partial row failure: other columns in the row still succeed; retry gives a fresh generation', async () => {
    app = await bootApp();
    mockControl.failNext({ match: (i) => i.model === 'mock/flaky', kind: 'failed', retryable: false, message: 'boom' });
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }, { model: 'mock/flaky' }], rows: [{ prompt: 'p' }] });
    let view = await settle(app, 'c');
    expect(cell(view, 'r1', 'fast').status).toBe('succeeded');
    expect(cell(view, 'r1', 'flaky').status).toBe('failed');
    expect(cell(view, 'r1', 'flaky').error).toMatchObject({ message: 'boom', retryable: false });
    // Failed generations do not self-heal.
    await sleep(100);
    expect(generateCalls().filter((c) => c.model === 'mock/flaky')).toHaveLength(1);

    await expect(run(app, 'cells.retry', { cell: 'c/r1/fast' })).rejects.toThrow(/only failed/);
    const retried = await run(app, 'cells.retry', { cell: 'c/r1/flaky' });
    expect(retried.generation.status).toBe('queued');
    expect(retried.generation.version).toBe(2);
    view = await settle(app, 'c');
    expect(cell(view, 'r1', 'flaky').status).toBe('succeeded');
    expect(cell(view, 'r1', 'flaky').versions).toBe(2);
  });

  it('retryable errors are retried within the budget, then fail', async () => {
    app = await bootApp();
    mockControl.failNext({ match: 'twice', retryable: true, times: 2, message: '503' });
    mockControl.failNext({ match: 'thrice', retryable: true, times: 3, message: '503' });
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'twice' }, { prompt: 'thrice' }] });
    const view = await settle(app, 'c');
    expect(cell(view, 'r1', 'fast').status).toBe('succeeded');
    expect(genRows(app, 'c', 'r1')[0]!.attempt).toBe(3);
    expect(cell(view, 'r2', 'fast').status).toBe('failed');
    expect(genRows(app, 'c', 'r2')[0]!.attempt).toBe(3);
    expect(generateCalls('twice')).toHaveLength(3);
    expect(generateCalls('thrice')).toHaveLength(3);
  });

  it('ambiguous submission lands in needs_attention and is never resubmitted', async () => {
    app = await bootApp();
    mockControl.failNext({ kind: 'ambiguous', message: 'submit timed out' });
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'ambig' }] });
    let view = await settle(app, 'c');
    expect(cell(view, 'r1', 'fast').status).toBe('needs_attention');
    expect(cell(view, 'r1', 'fast').error?.message).toBe('submit timed out');
    await sleep(100);
    await run(app, 'rows.update', { collection: 'c', row: 'r1', notes: 'still the same content' });
    view = await settle(app, 'c');
    expect(cell(view, 'r1', 'fast').status).toBe('needs_attention');
    expect(generateCalls('ambig')).toHaveLength(1);

    await run(app, 'cells.retry', { cell: 'c/r1/fast' });
    view = await settle(app, 'c');
    expect(cell(view, 'r1', 'fast').status).toBe('succeeded');
    expect(generateCalls('ambig')).toHaveLength(2);
  });

  it('provider-declared unsupported errors mark the cell unsupported', async () => {
    app = await bootApp();
    mockControl.failNext({ kind: 'unsupported', message: 'nope' });
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'u' }] });
    const view = await settle(app, 'c');
    expect(cell(view, 'r1', 'fast').status).toBe('unsupported');
    expect(cell(view, 'r1', 'fast').error).toMatchObject({ message: 'nope', retryable: false });
  });

  it('cells.cancel: queued at once, submitted only when confirmed', async () => {
    app = await bootApp({ config: { globalConcurrency: 1 } });
    const unhold = mockControl.hold('running');
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/slow' }], rows: [{ prompt: 'held' }, { prompt: 'queued' }] });
    await mockControl.waitForHeld(1, 'held');
    const q = await run(app, 'cells.cancel', { cell: 'c/r2/slow' });
    expect(q.generation?.status).toBe('cancelled');
    const r = await run(app, 'cells.cancel', { cell: 'c/r1/slow' });
    expect(r.generation?.status).toBe('cancelled');
    await until(() => app.runner.inFlightIds().length === 0);
    expect(mockControl.calls.filter((c) => c.type === 'cancel')).toHaveLength(1);
    const none = await run(app, 'cells.cancel', { cell: 'c/r1/slow' });
    expect(none.generation).toBeUndefined();

    // With a pending outcome the generation stays running.
    mockControl.cancelOutcome = 'pending';
    await run(app, 'rows.update', { collection: 'c', row: 'r2', notes: 'poke' });
    await mockControl.waitForHeld(1);
    const pendingCancel = await run(app, 'cells.cancel', { cell: `c/${mockControl.heldCalls()[0]!.prompt === 'held' ? 'r1' : 'r2'}/slow` });
    expect(pendingCancel.generation?.status).toBe('running');

    // Cancelled generations do not satisfy the cell: the reconciler filled both cells again.
    unhold();
    mockControl.release();
    const view = await settle(app, 'c');
    expect(cell(view, 'r1', 'slow').status).toBe('succeeded');
    expect(cell(view, 'r2', 'slow').status).toBe('succeeded');
    expect(genRows(app, 'c').map((g) => g.status).sort()).toEqual(['cancelled', 'cancelled', 'succeeded', 'succeeded']);
  });

  it('multiple outputs per cell and the count cap', async () => {
    app = await bootApp();
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast', count: 3 }, { model: 'mock/fast', id: 'too-many', count: 5 }], rows: [{ prompt: 'multi' }] });
    const view = await settle(app, 'c');
    expect(cell(view, 'r1', 'fast').outputs).toHaveLength(3);
    expect(cell(view, 'r1', 'fast').thumbnails).toHaveLength(3);
    expect(cell(view, 'r1', 'too-many').status).toBe('unsupported');
    expect(cell(view, 'r1', 'too-many').error?.message).toMatch(/count 5 exceeds/);
  });
});
