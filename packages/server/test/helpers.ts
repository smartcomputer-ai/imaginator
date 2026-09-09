import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { commandDefs, type CollectionView, type CommandInput, type CommandName, type CommandOutput } from '@imaginator/core';
import { createApp, type App, type AppDeps } from '../src/app.js';
import type { ConfigOverrides } from '../src/config.js';
import { generations } from '../src/db/schema.js';
import { mockControl } from '../src/providers/mock.js';

export { mockControl };

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'imaginator-test-'));
}

export const TEST_CONFIG: ConfigOverrides = {
  mock: true,
  log: () => {},
  reconcileDebounceMs: 25,
  retryBackoffMs: 5,
  globalConcurrency: 8,
};

/** Boot an app on a data dir (fresh temp dir by default) with the deterministic mock provider. */
export async function bootApp(opts: { dataDir?: string; config?: ConfigOverrides; deps?: AppDeps; resetMock?: boolean } = {}): Promise<App> {
  if (opts.resetMock !== false) mockControl.reset();
  mockControl.deterministic = true;
  const app = createApp({ ...TEST_CONFIG, dataDir: opts.dataDir ?? tempDir(), ...(opts.config ?? {}) }, opts.deps ?? {});
  await app.start();
  return app;
}

/** Run a command and validate its output against the core schema. */
export async function run<N extends CommandName>(app: App, name: N, input: CommandInput<N>): Promise<CommandOutput<N>> {
  const out = await app.commands[name].run(input);
  const check = commandDefs[name].output.safeParse(out);
  if (!check.success) throw new Error(`output of ${name} does not match its schema: ${JSON.stringify(check.error.issues, null, 1)}`);
  return out as CommandOutput<N>;
}

export async function until(fn: () => boolean | Promise<boolean>, opts: { timeoutMs?: number; what?: string } = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts.what ?? 'condition'}`);
    await sleep(10);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the collection has nothing queued or in flight and no reconcile pass pending. */
export async function settle(app: App, slug: string, timeoutMs = 15_000): Promise<CollectionView> {
  await until(
    async () => {
      await app.reconciler.settled(slug);
      const v = app.services.collections.get(slug);
      return v.inFlight === 0 && v.queued === 0;
    },
    { timeoutMs, what: `${slug} to settle` },
  );
  await app.reconciler.settled(slug);
  return app.services.collections.get(slug);
}

export function cell(view: CollectionView, row: string, column: string) {
  const c = view.cells.find((x) => x.row === row && x.column === column);
  if (!c) throw new Error(`no cell ${row}/${column}`);
  return c;
}

export function statusMap(view: CollectionView): Record<string, string> {
  return Object.fromEntries(view.cells.map((c) => [`${c.row}/${c.column}`, c.status]));
}

export function genRows(app: App, slug: string, row?: string, column?: string) {
  const conds = [eq(generations.collection, slug)];
  if (row) conds.push(eq(generations.row, row));
  if (column) conds.push(eq(generations.column, column));
  return app.services.ctx.db.select().from(generations).where(and(...conds)).orderBy(generations.seq).all();
}

export function generateCalls(prompt?: string) {
  return mockControl.calls.filter((c) => c.type === 'generate' && (prompt === undefined || c.prompt === prompt));
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
