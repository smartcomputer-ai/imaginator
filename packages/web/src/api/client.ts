import { commandDefs, type CommandInput, type CommandName, type CommandOutput } from '@imaginator/core';
import { markUnauthenticated } from './auth';

export interface ApiErrorBody {
  message: string;
  code?: string;
  issues?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly issues: unknown;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.issues = body.issues;
  }
}

export const API_BASE = '/api';

/**
 * Typed RPC: `POST /api/<command>` with a JSON body matching the command's
 * input schema. Output is validated against the zod schema in dev only.
 */
export async function call<N extends CommandName>(name: N, input: CommandInput<N>): Promise<CommandOutput<N>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input ?? {}),
    });
  } catch (e) {
    throw new ApiError(0, { message: `network error calling ${name}: ${(e as Error).message}`, code: 'network' });
  }

  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (!res.ok) throw new ApiError(res.status, { message: text.slice(0, 500) || res.statusText, code: 'http' });
      throw new ApiError(res.status, { message: `invalid JSON from ${name}`, code: 'parse' });
    }
  }

  if (!res.ok) {
    if (res.status === 401) markUnauthenticated();
    const body = (json as { error?: ApiErrorBody } | undefined)?.error;
    throw new ApiError(res.status, body ?? { message: res.statusText || `HTTP ${res.status}`, code: 'http' });
  }

  if (import.meta.env.DEV) {
    const parsed = commandDefs[name].output.safeParse(json);
    if (!parsed.success) {
      // Do not fail the UI on a schema drift, but make it visible.
      console.warn(`[api] ${name}: response does not match output schema`, parsed.error.issues, json);
    }
  }
  return json as CommandOutput<N>;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const issues = Array.isArray(e.issues) ? (e.issues as { message?: string; path?: unknown[] }[]) : [];
    const detail = issues
      .slice(0, 3)
      .map((i) => `${Array.isArray(i.path) && i.path.length ? i.path.join('.') + ': ' : ''}${i.message ?? ''}`)
      .filter(Boolean)
      .join('; ');
    return detail ? `${e.message} (${detail})` : e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
