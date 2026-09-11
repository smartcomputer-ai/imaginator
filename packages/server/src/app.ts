import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { ModelRegistry, type Provider } from '@imaginator/core';
import { AssetStore } from './assets/store.js';
import { createCommandRegistry, type CommandRegistry } from './commands/registry.js';
import { loadConfig, REPO_ROOT, type ConfigOverrides, type ServerConfig } from './config.js';
import { openDb } from './db/index.js';
import { Reconciler } from './engine/reconciler.js';
import { Runner } from './engine/runner.js';
import { EventBus } from './events/bus.js';
import { createHttpApp, type HttpApp } from './http/app.js';
import { createMcpHttp, type McpHttp } from './mcp/http.js';
import { buildProviders } from './providers/index.js';
import { createServices, type EngineHooks, type Services } from './services/index.js';

/** Recorded on every generation's request snapshot; never hashed. */
export const REGISTRY_VERSION = '2026-09-09.1';
/** Reported to MCP clients. */
export const SERVER_VERSION = '0.1.0';

export interface App {
  config: ServerConfig;
  services: Services;
  registry: ModelRegistry;
  commands: CommandRegistry;
  bus: EventBus;
  runner: Runner;
  reconciler: Reconciler;
  store: AssetStore;
  http: HttpApp;
  mcp: McpHttp;
  /** Boot: reconciler boot pass → tmp sweep → runner recovery + loop. */
  start(): Promise<void>;
  /** Listen on the configured (or given) port; returns the base URL. */
  listen(port?: number): Promise<string>;
  /** Abort in-flight work, stop the engine, close listeners and the DB. */
  stop(): Promise<void>;
}

export interface AppDeps {
  /** Replace the providers built from config (tests). */
  providers?: Provider[];
  registryVersion?: string;
}

export function createApp(overrides: ConfigOverrides = {}, deps: AppDeps = {}): App {
  const config = loadConfig(overrides);
  const opened = openDb(path.join(config.dataDir, 'imaginator.db'));
  const registry = new ModelRegistry(deps.providers ?? buildProviders(config), deps.registryVersion ?? REGISTRY_VERSION);
  const store = new AssetStore(config.dataDir);
  const bus = new EventBus();
  const hooks: EngineHooks = {};
  const services = createServices({ db: opened.db, bus, registry, store, config, hooks });
  const reconciler = new Reconciler(services, bus, registry, config);
  const runner = new Runner(services, registry, store, config, bus);
  hooks.abortGenerations = (ids, reason) => runner.abort(ids, reason);
  hooks.reconcileSettled = (slug) => reconciler.settled(slug);
  hooks.reconcileNow = (slug) => reconciler.runNow(slug);
  hooks.reconcilePending = (slug) => reconciler.isPending(slug);
  const commands = createCommandRegistry(services, registry);
  let baseUrl: string | undefined;
  const mcp = createMcpHttp({ commands, services, store, bus, version: SERVER_VERSION, baseUrl: () => baseUrl, log: config.log });
  const http = createHttpApp({ commands, services, bus, store, mcp, webDist: path.join(REPO_ROOT, 'packages', 'web', 'dist'), auth: config.auth, log: config.log });

  let server: ServerType | undefined;
  let started = false;
  let stopped = false;

  return {
    config,
    services,
    registry,
    commands,
    bus,
    runner,
    reconciler,
    store,
    http,
    mcp,

    async start() {
      if (started) return;
      started = true;
      reconciler.start();
      await reconciler.bootPass();
      const swept = await store.sweepTmp(runner.stagedPathsInUse(), config.tmpGraceMs);
      if (swept > 0) config.log(`swept ${swept} stale file(s) from ${store.tmpDir}`);
      await runner.start();
    },

    listen(port = config.port) {
      return new Promise<string>((resolve, reject) => {
        server = serve({ fetch: http.fetch, port, hostname: config.host }, (info) => {
          baseUrl = `http://${config.host}:${info.port}`;
          resolve(baseUrl);
        });
        server.once('error', reject);
      });
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      await runner.stop();
      await reconciler.stop();
      await mcp.closeAll();
      http.closeStreams();
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
      }
      opened.close();
    },
  };
}
