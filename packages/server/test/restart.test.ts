import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { AbortReason } from '../src/engine/runner.js';
import { bootApp, cell, generateCalls, genRows, mockControl, run, settle, sleep, until } from './helpers.js';

let app: App;
afterEach(async () => {
  await app?.stop();
});

describe('restart recovery', () => {
  it('crash between submitting and providerRef → needs_attention, never resubmitted', async () => {
    app = await bootApp();
    mockControl.hold('start');
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'crash' }] });
    await mockControl.waitForHeld(1);
    const dir = app.config.dataDir;
    expect(genRows(app, 'c')[0]!.status).toBe('submitting');
    await app.stop();

    app = await bootApp({ dataDir: dir, resetMock: false });
    mockControl.release();
    const view = await settle(app, 'c');
    expect(cell(view, 'r1', 'fast').status).toBe('needs_attention');
    expect(cell(view, 'r1', 'fast').error?.code).toBe('restart_submitting');
    await sleep(100);
    expect(generateCalls('crash')).toHaveLength(1);
    // A reconcile pass does not touch it either.
    await run(app, 'rows.update', { collection: 'c', row: 'r1', notes: 'n' });
    await settle(app, 'c');
    expect(generateCalls('crash')).toHaveLength(1);
    expect(genRows(app, 'c')).toHaveLength(1);
  });

  it('restart during polling → resume() monitors the same job', async () => {
    app = await bootApp();
    mockControl.hold('running');
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/slow' }], rows: [{ prompt: 'poll' }] });
    await mockControl.waitForHeld(1);
    const dir = app.config.dataDir;
    const before = genRows(app, 'c')[0]!;
    expect(before.status).toBe('running');
    expect(before.providerRef?.data.jobId).toBeTruthy();
    await app.stop();

    app = await bootApp({ dataDir: dir, resetMock: false });
    await mockControl.waitForHeld(1, (h) => h.type === 'resume');
    expect(mockControl.calls.filter((c) => c.type === 'resume')).toHaveLength(1);
    expect(generateCalls('poll')).toHaveLength(1);
    mockControl.release();
    const view = await settle(app, 'c');
    expect(cell(view, 'r1', 'slow').status).toBe('succeeded');
    expect(cell(view, 'r1', 'slow').generation).toBe(before.id);
    expect(genRows(app, 'c')).toHaveLength(1);
  });

  it('restart during running without resume() → needs_attention with the handle kept', async () => {
    app = await bootApp();
    mockControl.hold('running');
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/slow' }], rows: [{ prompt: 'noresume' }] });
    await mockControl.waitForHeld(1);
    const dir = app.config.dataDir;
    await app.stop();

    const { mockProvider } = await import('../src/providers/mock.js');
    const noResume = { ...mockProvider };
    delete (noResume as { resume?: unknown }).resume;
    app = await bootApp({ dataDir: dir, resetMock: false, deps: { providers: [noResume] } });
    const view = await settle(app, 'c');
    expect(cell(view, 'r1', 'slow').status).toBe('needs_attention');
    expect(genRows(app, 'c')[0]!.providerRef).toBeTruthy();
    expect(generateCalls('noresume')).toHaveLength(1);
  });

  it('restart during download reuses staged files and never regenerates', async () => {
    app = await bootApp();
    app.runner.hooks.beforeIngest = (_id, signal) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason ?? new AbortReason('aborted')), { once: true }));
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast', count: 2 }], rows: [{ prompt: 'dl' }] });
    await until(() => genRows(app, 'c')[0]?.status === 'downloading');
    const dir = app.config.dataDir;
    const staged = genRows(app, 'c')[0]!.pendingOutputs!;
    expect(staged).toHaveLength(2);
    for (const p of staged) expect('stagedPath' in p && fs.existsSync(p.stagedPath)).toBe(true);
    await app.stop();
    const db = new Database(path.join(dir, 'imaginator.db'), { readonly: true });
    expect((db.prepare('select status from generations').get() as { status: string }).status).toBe('downloading');
    db.close();

    app = await bootApp({ dataDir: dir, resetMock: false, config: { tmpGraceMs: 0 } });
    const view = await settle(app, 'c');
    expect(cell(view, 'r1', 'fast').status).toBe('succeeded');
    expect(cell(view, 'r1', 'fast').outputs).toHaveLength(2);
    expect(generateCalls('dl')).toHaveLength(1);
    for (const p of staged) expect('stagedPath' in p && fs.existsSync(p.stagedPath)).toBe(false);
    for (const id of cell(view, 'r1', 'fast').outputs) {
      const a = app.services.assets.requireRow(id);
      expect(fs.existsSync(app.store.originalPath(a.id, a.ext))).toBe(true);
    }
  });

  it('restart during download with missing staged files → failed with a retrieval error', async () => {
    app = await bootApp();
    app.runner.hooks.beforeIngest = (_id, signal) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason ?? new AbortReason('aborted')), { once: true }));
    await run(app, 'collections.create', { slug: 'c', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'lost' }] });
    await until(() => genRows(app, 'c')[0]?.status === 'downloading');
    const dir = app.config.dataDir;
    const staged = genRows(app, 'c')[0]!.pendingOutputs!;
    await app.stop();
    for (const p of staged) if ('stagedPath' in p) fs.unlinkSync(p.stagedPath);

    app = await bootApp({ dataDir: dir, resetMock: false });
    const view = await settle(app, 'c');
    expect(cell(view, 'r1', 'fast').status).toBe('failed');
    expect(cell(view, 'r1', 'fast').error?.code).toBe('retrieval');
    expect(generateCalls('lost')).toHaveLength(1);
  });

  it('queued work survives a restart and stale queued work of a paused collection is cancelled on boot', async () => {
    app = await bootApp({ config: { globalConcurrency: 0 } });
    await run(app, 'collections.create', { slug: 'live', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'q' }] });
    await run(app, 'collections.create', { slug: 'paused', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'q2' }] });
    await app.reconciler.settled('live');
    await app.reconciler.settled('paused');
    expect(genRows(app, 'live')[0]!.status).toBe('queued');
    expect(genRows(app, 'paused')[0]!.status).toBe('queued');
    // Pause directly in the DB so the running reconciler does not see it (simulates an edit before a crash).
    const { collections } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    app.services.ctx.db.update(collections).set({ status: 'paused' }).where(eq(collections.slug, 'paused')).run();
    const dir = app.config.dataDir;
    await app.stop();

    app = await bootApp({ dataDir: dir });
    const live = await settle(app, 'live');
    expect(cell(live, 'r1', 'fast').status).toBe('succeeded');
    const paused = await settle(app, 'paused');
    expect(cell(paused, 'r1', 'fast').status).toBe('missing');
    expect(genRows(app, 'paused').map((g) => g.status)).toEqual(['cancelled']);
  });
});
