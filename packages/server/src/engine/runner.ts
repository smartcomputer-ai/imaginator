import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {
  ProviderError,
  isRemoteOutput,
  providerIdOf,
  type GenerateContext,
  type GenerateResult,
  type GenerationError,
  type ModelRegistry,
  type PendingOutput,
} from '@imaginator/core';
import type { AssetStore, PlacedFile } from '../assets/store.js';
import type { ServerConfig } from '../config.js';
import type { GenerationRow } from '../db/schema.js';
import type { EventBus } from '../events/bus.js';
import type { Services } from '../services/index.js';

export class AbortReason extends Error {
  constructor(readonly reason: 'shutdown' | 'cancelled' | 'deleted' | string) {
    super(`aborted: ${reason}`);
    this.name = 'AbortReason';
  }
}

export type ExecuteMode = 'generate' | 'resume' | 'download';

export interface RunnerTestHooks {
  /** Called after `downloading` is committed and before outputs are ingested. May await; must honor `signal`. */
  beforeIngest?: (generationId: string, signal: AbortSignal) => Promise<void>;
}

interface InFlight {
  id: string;
  provider: string;
  model: string;
  controller: AbortController;
  promise: Promise<void>;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new AbortReason('aborted'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new AbortReason('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function classify(e: unknown): GenerationError & { kind: 'failed' | 'ambiguous' | 'unsupported' } {
  if (e instanceof ProviderError) {
    return { kind: e.kind, retryable: e.retryable, message: e.message, ...(e.code !== undefined ? { code: e.code } : {}) };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { kind: 'failed', retryable: false, message };
}

const DEFAULT_PROVIDER_CONCURRENCY = 4;

/**
 * The in-process job loop (DESIGN §4.2). The `generations` table is the
 * queue; this class only decides what to run and drives `execute()`.
 */
export class Runner {
  readonly hooks: RunnerTestHooks = {};
  private readonly inFlight = new Map<string, InFlight>();
  private stopped = true;
  private ticking = false;
  private tickAgain = false;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly services: Services,
    private readonly registry: ModelRegistry,
    private readonly store: AssetStore,
    private readonly config: ServerConfig,
    private readonly bus: EventBus,
  ) {}

  /** Recovery for rows persisted mid-flight, then the pick loop. */
  async start(): Promise<void> {
    this.stopped = false;
    this.unsubscribe = this.bus.on((e) => {
      if (e.type === 'generation.updated' && e.status === 'queued') this.tick();
    });
    this.recover();
    this.tick();
  }

  /** Abort in-flight execution (no DB writes follow an abort) and wait for it to unwind. */
  async stop(timeoutMs = 5000): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const entries = [...this.inFlight.values()];
    for (const e of entries) e.controller.abort(new AbortReason('shutdown'));
    await Promise.race([Promise.allSettled(entries.map((e) => e.promise)), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  abort(ids: string[], reason: string): void {
    for (const id of ids) this.inFlight.get(id)?.controller.abort(new AbortReason(reason));
  }

  inFlightIds(): string[] {
    return [...this.inFlight.keys()];
  }

  /** Staged files referenced by unfinished generations; preserved by the tmp sweep. */
  stagedPathsInUse(): Set<string> {
    const out = new Set<string>();
    for (const g of this.services.generations.listByStatus(['downloading'])) {
      for (const p of g.pendingOutputs ?? []) if ('stagedPath' in p) out.add(p.stagedPath);
    }
    return out;
  }

  // -- pick loop ----------------------------------------------------------------

  tick(): void {
    if (this.stopped) return;
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        this.pickOnce();
      } while (this.tickAgain && !this.stopped);
    } catch (e) {
      this.config.log(`runner tick failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private pickOnce(): void {
    let global = this.inFlight.size;
    const byProvider = new Map<string, number>();
    const byModel = new Map<string, number>();
    for (const f of this.inFlight.values()) {
      byProvider.set(f.provider, (byProvider.get(f.provider) ?? 0) + 1);
      byModel.set(f.model, (byModel.get(f.model) ?? 0) + 1);
    }
    const claimed = this.services.generations.claimQueued((g) => {
      if (global >= this.config.globalConcurrency) return false;
      const providerId = providerIdOf(g.request.model);
      const provider = this.registry.provider(providerId);
      if (!provider) return false;
      const spec = this.registry.get(g.request.model);
      const providerLimit = this.config.providers[providerId]?.concurrency ?? provider.concurrency ?? DEFAULT_PROVIDER_CONCURRENCY;
      if ((byProvider.get(providerId) ?? 0) >= providerLimit) return false;
      if (spec?.concurrency !== undefined && (byModel.get(g.request.model) ?? 0) >= spec.concurrency) return false;
      global++;
      byProvider.set(providerId, (byProvider.get(providerId) ?? 0) + 1);
      byModel.set(g.request.model, (byModel.get(g.request.model) ?? 0) + 1);
      return true;
    });
    for (const g of claimed) this.spawn(g, 'generate');
  }

  private spawn(g: GenerationRow, mode: ExecuteMode): void {
    const controller = new AbortController();
    const entry: InFlight = { id: g.id, provider: providerIdOf(g.request.model), model: g.request.model, controller, promise: Promise.resolve() };
    entry.promise = this.execute(g, mode, controller.signal)
      .catch((e) => this.config.log(`[${g.id}] execute crashed: ${(e as Error)?.stack ?? e}`))
      .finally(() => {
        this.inFlight.delete(g.id);
        this.tick();
      });
    this.inFlight.set(g.id, entry);
  }

  // -- boot recovery --------------------------------------------------------------

  private recover(): void {
    const gens = this.services.generations;
    for (const g of gens.listByStatus(['submitting', 'running', 'downloading'])) {
      switch (g.status) {
        case 'submitting':
          gens.markNeedsAttention(
            g.id,
            'server restarted while submitting; the request may have been accepted and charged, so it was not resubmitted',
            'restart_submitting',
          );
          break;
        case 'running': {
          const provider = this.registry.providerFor(g.request.model);
          if (g.providerRef && provider?.resume) this.spawn(g, 'resume');
          else {
            gens.markNeedsAttention(
              g.id,
              `server restarted while running; ${provider ? 'the provider cannot resume monitoring' : 'the provider is not available'}; handle kept for inspection`,
              'restart_running',
            );
          }
          break;
        }
        case 'downloading':
          this.spawn(g, 'download');
          break;
      }
    }
  }

  // -- execution --------------------------------------------------------------------

  private makeContext(g: GenerationRow, signal: AbortSignal): GenerateContext {
    return {
      signal,
      asset: async (id) => {
        const a = this.services.assets.requireRow(id);
        const bytes = await this.store.readOriginal(a.id, a.ext);
        return { bytes, mime: a.mime, path: this.store.originalPath(a.id, a.ext) };
      },
      setProviderRef: async (ref) => {
        if (!this.services.generations.markRunning(g.id, ref)) throw signal.reason ?? new AbortReason(`generation ${g.id} is no longer active`);
      },
      sleep: (ms) => abortableSleep(ms, signal),
      log: (m) => this.config.log(`[${g.id}] ${m}`),
    };
  }

  private async execute(g: GenerationRow, mode: ExecuteMode, signal: AbortSignal): Promise<void> {
    const gens = this.services.generations;
    try {
      if (mode === 'download') {
        await this.ingest(g.id, g.pendingOutputs ?? [], signal);
        return;
      }
      const provider = this.registry.providerFor(g.request.model);
      if (!provider) {
        gens.markFailed(g.id, { message: `provider for ${g.request.model} is not available`, code: 'no_provider', retryable: false });
        return;
      }
      const ctx = this.makeContext(g, signal);
      let attempt = g.attempt;
      for (;;) {
        let result: GenerateResult;
        try {
          result = mode === 'resume' ? await provider.resume!(g.providerRef!, ctx) : await provider.generate(g.request, ctx);
        } catch (e) {
          if (signal.aborted) throw signal.reason ?? e;
          const err = classify(e);
          const error: GenerationError = { message: err.message, retryable: err.retryable, ...(err.code !== undefined ? { code: err.code } : {}) };
          if (err.kind === 'ambiguous') {
            gens.markNeedsAttention(g.id, err.message, err.code ?? 'ambiguous');
            return;
          }
          if (err.kind === 'unsupported') {
            gens.markUnsupported(g.id, error);
            return;
          }
          if (err.retryable && attempt < this.config.maxAttempts) {
            attempt++;
            if (mode === 'generate' && !gens.markRetrying(g.id, attempt, error)) return;
            ctx.log(`attempt ${attempt - 1} failed (${err.message}); retrying`);
            await abortableSleep(this.config.retryBackoffMs * 2 ** (attempt - 2), signal);
            continue;
          }
          gens.markFailed(g.id, error);
          return;
        }
        await this.complete(g, result, signal);
        return;
      }
    } catch (e) {
      if (signal.aborted) {
        this.config.log(`[${g.id}] aborted (${(signal.reason as AbortReason)?.reason ?? 'unknown'}); state left as persisted`);
        return;
      }
      gens.markFailed(g.id, { message: `internal error: ${(e as Error)?.message ?? String(e)}`, code: 'internal', retryable: false });
    }
  }

  /** Stage inline outputs, commit `downloading`, then ingest. */
  private async complete(g: GenerationRow, result: GenerateResult, signal: AbortSignal): Promise<void> {
    const pending: PendingOutput[] = [];
    for (const o of result.outputs) {
      if (isRemoteOutput(o)) {
        pending.push({ url: o.url, ...(o.mime !== undefined ? { mime: o.mime } : {}), ...(o.meta !== undefined ? { meta: o.meta } : {}) });
      } else {
        const stagedPath = await this.store.stageBytes(o.bytes, o.mime);
        pending.push({ stagedPath, mime: o.mime, ...(o.meta !== undefined ? { meta: o.meta } : {}) });
      }
    }
    if (!this.services.generations.markDownloading(g.id, pending, result.cost, result.providerMeta)) {
      for (const p of pending) if ('stagedPath' in p) await this.store.discardStaged(p.stagedPath);
      return;
    }
    if (this.hooks.beforeIngest) await this.hooks.beforeIngest(g.id, signal);
    await this.ingest(g.id, pending, signal);
  }

  /** Turn pending outputs into assets and mark `succeeded` in one transaction. Never calls the provider. */
  private async ingest(id: string, pending: PendingOutput[], signal: AbortSignal): Promise<void> {
    const placed: PlacedFile[] = [];
    try {
      if (pending.length === 0) throw new Error('provider returned no outputs');
      for (const p of pending) {
        let stagedPath: string;
        let mime: string | undefined = p.mime;
        if ('stagedPath' in p) {
          if (!fs.existsSync(p.stagedPath)) throw new Error(`staged output file is missing: ${p.stagedPath}`);
          stagedPath = p.stagedPath;
        } else {
          const r = await this.store.stageUrl(p.url, { signal, ...(p.mime !== undefined ? { mime: p.mime } : {}) });
          stagedPath = r.path;
          mime = r.mime ?? p.mime;
        }
        const analyzed = await this.store.analyze(stagedPath, mime);
        placed.push(await this.store.place(analyzed, this.services.assets.allocateId()));
      }
      if (this.services.generations.markSucceeded(id, placed)) {
        for (const p of placed) this.store.ensureThumb(p.id, p.ext).catch((e) => this.config.log(`thumbnail for ${p.id} failed: ${(e as Error).message}`));
      } else {
        for (const p of placed) await this.store.unplace(p);
      }
    } catch (e) {
      if (signal.aborted) {
        // Put moved files back so recovery can reuse them.
        for (const p of placed) await fsp.rename(p.finalPath, p.path).catch(() => {});
        throw e;
      }
      for (const p of placed) await this.store.unplace(p);
      this.services.generations.markFailed(id, { message: `output retrieval failed: ${(e as Error)?.message ?? String(e)}`, code: 'retrieval', retryable: false });
    }
  }
}
