import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ProviderConfig {
  apiKey?: string;
  concurrency?: number;
}

export interface AuthConfig {
  /** Password for the web UI login (`POST /api/auth/login`). */
  password: string;
  /** Bearer token for API and MCP clients (`Authorization: Bearer <key>`). */
  apiKey: string;
  /** Session cookie lifetime in ms. */
  sessionTtlMs: number;
}

export interface ServerConfig {
  /** Absolute path of the data directory (db, assets, tmp). */
  dataDir: string;
  port: number;
  host: string;
  globalConcurrency: number;
  providers: Record<string, ProviderConfig>;
  /** Mock provider enabled. On when IMAGINATOR_MOCK=1 or when no real key is present. */
  mock: boolean;
  /** Reconciler debounce in ms. */
  reconcileDebounceMs: number;
  /** Runner retry budget for retryable provider errors. */
  maxAttempts: number;
  /** Base backoff between attempts, ms. */
  retryBackoffMs: number;
  /** Grace period before unreferenced files in data/tmp are swept on boot. */
  tmpGraceMs: number;
  /**
   * Authenticated mode (AUTH_ENABLED=1). Off by default: the server is a
   * localhost tool. When set, every /api, /assets and /mcp request needs a
   * session cookie (web login) or the bearer API key (MCP, scripts).
   */
  auth?: AuthConfig;
  /** Log function; tests can silence it. */
  log: (message: string) => void;
}

export type ConfigOverrides = Partial<Omit<ServerConfig, 'providers'>> & { providers?: Record<string, ProviderConfig> };

const PROVIDER_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  bfl: 'BFL_API_KEY',
  fal: 'FAL_KEY',
  google: 'GOOGLE_API_KEY',
  replicate: 'REPLICATE_API_TOKEN',
};

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo root: packages/server/src → ../../.. */
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

/** Minimal .env parser: KEY=VALUE lines, `#` comments, optional quotes. Does not override existing env. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

export function loadDotenv(file = path.join(REPO_ROOT, '.env'), env: NodeJS.ProcessEnv = process.env): void {
  if (!fs.existsSync(file)) return;
  const parsed = parseDotenv(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) if (env[k] === undefined) env[k] = v;
}

function boolEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = (env[key] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** AUTH_ENABLED → AuthConfig; throws when enabled without both secrets so a misconfiguration cannot silently lock the server open or closed. */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig | undefined {
  if (!boolEnv(env, 'AUTH_ENABLED')) return undefined;
  const password = env.AUTH_PASSWORD ?? '';
  const apiKey = env.AUTH_API_KEY ?? '';
  const missing = [...(password ? [] : ['AUTH_PASSWORD']), ...(apiKey ? [] : ['AUTH_API_KEY'])];
  if (missing.length) throw new Error(`AUTH_ENABLED is set but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} empty`);
  return { password, apiKey, sessionTtlMs: intEnv(env, 'AUTH_SESSION_DAYS', 30) * 24 * 60 * 60 * 1000 };
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(overrides: ConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, keyName] of Object.entries(PROVIDER_KEYS)) {
    const apiKey = env[keyName];
    const concurrency = env[`IMAGINATOR_${id.toUpperCase()}_CONCURRENCY`];
    if (apiKey || concurrency) {
      providers[id] = {
        ...(apiKey ? { apiKey } : {}),
        ...(concurrency ? { concurrency: Number(concurrency) } : {}),
      };
    }
  }
  const mockConcurrency = env.IMAGINATOR_MOCK_CONCURRENCY;
  if (mockConcurrency) providers.mock = { concurrency: Number(mockConcurrency) };
  const hasRealKey = Object.values(providers).some((p) => !!p.apiKey);
  const mock = env.IMAGINATOR_MOCK === '1' || env.IMAGINATOR_MOCK === 'true' || !hasRealKey;

  const dataDirRaw = env.IMAGINATOR_DATA_DIR ?? './data';
  const auth = loadAuthConfig(env);
  const config: ServerConfig = {
    dataDir: path.resolve(REPO_ROOT, dataDirRaw),
    port: intEnv(env, 'IMAGINATOR_PORT', 4747),
    host: env.IMAGINATOR_HOST ?? '127.0.0.1',
    globalConcurrency: intEnv(env, 'IMAGINATOR_GLOBAL_CONCURRENCY', 8),
    providers,
    mock,
    reconcileDebounceMs: 200,
    maxAttempts: 3,
    retryBackoffMs: 500,
    tmpGraceMs: 60 * 60 * 1000,
    ...(auth ? { auth } : {}),
    log: (m) => console.log(m),
    ...overrides,
    ...(overrides.providers ? { providers: { ...providers, ...overrides.providers } } : {}),
  };
  if (overrides.dataDir) config.dataDir = path.resolve(overrides.dataDir);
  return config;
}
