import { ProviderError } from '@imaginator/core';

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: RequestInit['body'];
  /** Per-attempt timeout. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Retry on 429/5xx/network errors with backoff. Only set this for calls that
   * are safe to repeat (polls, downloads, input uploads) or submissions with a
   * provider-honored idempotency key. Never for a plain submission POST.
   */
  retry?: { attempts?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void> };
}

export class HttpError extends Error {
  readonly status: number;
  readonly bodyText: string;
  constructor(status: number, bodyText: string, url: string) {
    super(`HTTP ${status} from ${url}${bodyText ? `: ${bodyText.slice(0, 300)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** `fetch` with timeout and optional bounded retry. Throws `HttpError` on non-2xx. */
export async function fetchWithRetry(url: string, opts: HttpOptions = {}): Promise<Response> {
  const attempts = Math.max(1, opts.retry?.attempts ?? (opts.retry ? 4 : 1));
  const backoff = opts.retry?.backoffMs ?? 500;
  const sleep = opts.retry?.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    const controller = new AbortController();
    const onAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${opts.timeoutMs ?? 60_000}ms`)), opts.timeoutMs ?? 60_000);
    try {
      const res = await fetch(url, { method: opts.method ?? 'GET', headers: opts.headers, body: opts.body, signal: controller.signal });
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      lastError = new HttpError(res.status, text, url);
      if (!isRetryableStatus(res.status) || attempt === attempts) throw lastError;
    } catch (e) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? e;
      if (e instanceof HttpError) {
        if (!isRetryableStatus(e.status) || attempt === attempts) throw e;
      } else {
        lastError = e;
        if (attempt === attempts) throw e;
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
    await sleep(backoff * 2 ** (attempt - 1));
  }
  throw lastError;
}

export async function fetchJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, opts);
  return (await res.json()) as T;
}

export async function fetchBytes(url: string, opts: HttpOptions = {}): Promise<{ bytes: Uint8Array; mime: string | undefined }> {
  const res = await fetchWithRetry(url, opts);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || undefined;
  return { bytes, mime };
}

/** Map an HTTP failure of a *safe-to-repeat* call into a ProviderError for the runner. */
export function toProviderError(e: unknown, context: string): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof HttpError) {
    return new ProviderError(`${context}: ${e.message}`, { retryable: isRetryableStatus(e.status), code: `http_${e.status}`, cause: e });
  }
  return new ProviderError(`${context}: ${(e as Error)?.message ?? String(e)}`, { retryable: true, cause: e });
}
