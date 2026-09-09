import { asc } from 'drizzle-orm';
import type { ModelRegistry } from '@imaginator/core';
import type { ServerConfig } from '../config.js';
import { collections, type GenerationRow } from '../db/schema.js';
import type { EventBus } from '../events/bus.js';
import type { Services } from '../services/index.js';

interface Pending {
  timer: NodeJS.Timeout;
  promise: Promise<void>;
  resolve: () => void;
}

/**
 * Keeps live collections filled in (DESIGN §4.1). Debounced per collection
 * after collection/row/column events, run at once on resume/unpause and on
 * boot, never on a timer. The DB work is one transaction in the reconcile
 * service; remote cancellation of superseded submitted work happens here.
 */
export class Reconciler {
  private pending = new Map<string, Pending>();
  private running = new Map<string, Promise<void>>();
  private cancelRequested = new Set<string>();
  private background = new Set<Promise<void>>();
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  constructor(
    private readonly services: Services,
    private readonly bus: EventBus,
    private readonly registry: ModelRegistry,
    private readonly config: ServerConfig,
  ) {}

  start(): void {
    this.stopped = false;
    this.unsubscribe = this.bus.on((e) => {
      if (!('collection' in e)) return;
      if (e.type === 'collection.deleted') {
        this.clearPending(e.collection);
        return;
      }
      if (e.type === 'collection.created' || e.type === 'collection.updated' || e.type.startsWith('row.') || e.type.startsWith('column.')) {
        this.schedule(e.collection);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    for (const slug of [...this.pending.keys()]) this.clearPending(slug);
    await Promise.allSettled([...this.running.values(), ...this.background]);
  }

  /** Debounced pass. */
  schedule(slug: string, delayMs = this.config.reconcileDebounceMs): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const existing = this.pending.get(slug);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.fire(slug), delayMs);
      return existing.promise;
    }
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    const timer = setTimeout(() => this.fire(slug), delayMs);
    this.pending.set(slug, { timer, promise, resolve });
    return promise;
  }

  /** Run a pass right away (cancels a pending debounce). */
  runNow(slug: string): Promise<void> {
    const p = this.pending.get(slug);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(slug);
      const run = this.run(slug);
      run.finally(() => p.resolve());
      return run;
    }
    return this.run(slug);
  }

  /** Resolves once no pass is pending or running for the collection. */
  async settled(slug: string): Promise<void> {
    for (;;) {
      const p = this.pending.get(slug) ?? this.running.get(slug);
      if (!p) return;
      await ('promise' in p ? p.promise : p);
    }
  }

  /** Boot: one pass per collection. */
  async bootPass(): Promise<void> {
    const slugs = this.services.ctx.db.select({ slug: collections.slug }).from(collections).orderBy(asc(collections.createdAt)).all();
    for (const { slug } of slugs) await this.run(slug);
  }

  private clearPending(slug: string): void {
    const p = this.pending.get(slug);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(slug);
    p.resolve();
  }

  private fire(slug: string): void {
    const p = this.pending.get(slug);
    this.pending.delete(slug);
    this.run(slug).finally(() => p?.resolve());
  }

  private run(slug: string): Promise<void> {
    const prior = this.running.get(slug);
    const task = (prior ?? Promise.resolve()).then(() => this.pass(slug));
    const tracked = task.finally(() => {
      if (this.running.get(slug) === tracked) this.running.delete(slug);
    });
    this.running.set(slug, tracked);
    return tracked;
  }

  private async pass(slug: string): Promise<void> {
    if (this.stopped) return;
    let result;
    try {
      result = this.services.reconcile(slug);
    } catch (e) {
      this.config.log(`reconcile ${slug} failed: ${(e as Error).message}`);
      return;
    }
    if (result.inserted.length === 0 && result.cancelled.length === 0) {
      // Nothing changed: still move the cursor so `collections.wait` callers see the pass happened.
      this.bus.touch(slug);
    }
    for (const g of result.superseded) this.requestCancel(g);
  }

  /** Superseded submitted work: cancel remotely when possible; only `confirmed` marks it cancelled. */
  private requestCancel(g: GenerationRow): void {
    if (this.cancelRequested.has(g.id)) return;
    if (!g.providerRef) return; // still submitting: no handle to cancel with
    const provider = this.registry.providerFor(g.request.model);
    if (!provider?.cancel) return;
    this.cancelRequested.add(g.id);
    const task = provider
      .cancel(g.providerRef)
      .then((outcome) => {
        if (outcome === 'confirmed') {
          if (this.services.generations.markCancelled(g.id)) {
            this.services.ctx.hooks.abortGenerations?.([g.id], 'cancelled');
          }
        } else {
          this.config.log(`cancel of superseded generation ${g.id}: ${outcome}; monitoring continues`);
        }
      })
      .catch((e) => this.config.log(`cancel of ${g.id} failed: ${(e as Error).message}`))
      .finally(() => {
        this.background.delete(task);
        this.cancelRequested.delete(g.id);
      });
    this.background.add(task);
  }
}
