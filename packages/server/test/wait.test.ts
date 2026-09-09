import { afterEach, describe, expect, it } from 'vitest';
import { formatCursor } from '@imaginator/core';
import type { App } from '../src/app.js';
import { bootApp, cell, mockControl, run, settle } from './helpers.js';

let app: App;
afterEach(async () => {
  await app?.stop();
});

describe('collections.wait', () => {
  it('a wait on a cursor taken before an edit returns only after the reconcile pass', async () => {
    app = await bootApp({ config: { reconcileDebounceMs: 250 } });
    const created = await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }], status: 'live' });
    await settle(app, 'c');
    const before = app.services.collections.get('c').cursor;
    expect(created.cursor).toBeTruthy();

    const t0 = Date.now();
    const added = await run(app, 'rows.add', { collection: 'c', rows: [{ prompt: 'w' }] });
    expect(added.cursor).not.toBe(before);
    // Nothing is queued yet: the reconciler is debouncing.
    expect(app.services.collections.get('c').queued + app.services.collections.get('c').inFlight).toBe(0);

    const w = await run(app, 'collections.wait', { collection: 'c', cursor: before, timeoutMs: 5000 });
    expect(w.changed).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    expect(w.queued + w.inFlight).toBeGreaterThanOrEqual(0);
    expect(cell(app.services.collections.get('c'), 'r1', 'fast').status).not.toBe('missing');

    // The mutation's own cursor also waits for the pass, then the agent loop converges.
    let cursor = added.cursor;
    for (let i = 0; i < 20; i++) {
      const r = await run(app, 'collections.wait', { collection: 'c', cursor, timeoutMs: 5000 });
      cursor = r.cursor;
      if (r.inFlight === 0 && r.queued === 0) break;
    }
    expect(cell(app.services.collections.get('c'), 'r1', 'fast').status).toBe('succeeded');
  });

  it('a no-op edit still lets wait return after the pass (cursor advances without new generations)', async () => {
    app = await bootApp();
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'same' }] });
    await settle(app, 'c');
    const upd = await run(app, 'rows.update', { collection: 'c', row: 'r1', prompt: 'same' });
    const w = await run(app, 'collections.wait', { collection: 'c', cursor: upd.cursor, timeoutMs: 3000 });
    expect(w.changed).toBe(true);
    expect(w.queued).toBe(0);
    expect(w.inFlight).toBe(0);
  });

  it('times out with changed=false when nothing happens; stale cursors return at once', async () => {
    app = await bootApp();
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'x' }] });
    const view = await settle(app, 'c');
    const t0 = Date.now();
    const w = await run(app, 'collections.wait', { collection: 'c', cursor: view.cursor, timeoutMs: 150 });
    expect(w.changed).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);

    const stale = await run(app, 'collections.wait', { collection: 'c', cursor: formatCursor('otherboot', 999), timeoutMs: 5000 });
    expect(stale.changed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);

    await expect(run(app, 'collections.wait', { collection: 'nope', cursor: view.cursor })).rejects.toThrow(/not found/);
  });

  it('wakes up on generation progress', async () => {
    app = await bootApp();
    mockControl.hold('complete');
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'held' }] });
    await mockControl.waitForHeld(1);
    const cursor = app.services.collections.get('c').cursor;
    const pending = run(app, 'collections.wait', { collection: 'c', cursor, timeoutMs: 5000 });
    mockControl.release();
    const w = await pending;
    expect(w.changed).toBe(true);
    await settle(app, 'c');
  });
});
