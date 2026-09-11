import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ApiError, type ApiErrorBody } from './client';

export interface AuthStatus {
  /** Server runs in authenticated mode (AUTH_ENABLED). */
  enabled: boolean;
  /** This browser holds a valid session (always true when auth is disabled). */
  authenticated: boolean;
  via?: 'session' | 'apiKey';
}

// ---------------------------------------------------------------------------
// Auth state store: one snapshot shared by the gate, the header and the client.
// `call()` flips it to logged-out on any 401 so an expired session shows the
// login page instead of a wall of failed requests.
// ---------------------------------------------------------------------------

type State = { status: 'loading' } | ({ status: 'ready' } & AuthStatus);

let state: State = { status: 'loading' };
const listeners = new Set<() => void>();

function setState(next: State): void {
  state = next;
  listeners.forEach((l) => l());
}

export function useAuthState(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

/** Called by the API client on a 401. */
export function markUnauthenticated(): void {
  if (state.status === 'ready' && state.enabled && state.authenticated) setState({ status: 'ready', enabled: true, authenticated: false });
}

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`/api/auth/${path}`, { headers: { accept: 'application/json', 'content-type': 'application/json' }, ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { error?: ApiErrorBody } | undefined;
    throw new ApiError(res.status, body?.error ?? { message: res.statusText || `HTTP ${res.status}`, code: 'http' });
  }
  return res;
}

export async function refreshAuthStatus(): Promise<AuthStatus> {
  const status = (await authFetch('status').then((r) => r.json())) as AuthStatus;
  setState({ status: 'ready', ...status });
  return status;
}

export async function login(password: string): Promise<void> {
  await authFetch('login', { method: 'POST', body: JSON.stringify({ password }) });
  setState({ status: 'ready', enabled: true, authenticated: true, via: 'session' });
}

export async function logout(): Promise<void> {
  await authFetch('logout', { method: 'POST', body: '{}' });
  setState({ status: 'ready', enabled: true, authenticated: false });
}

/** Load the status once on mount; exposes the shared snapshot. */
export function useAuth(): State & { error?: string; retry: () => void } {
  const snapshot = useAuthState();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    setError(undefined);
    refreshAuthStatus().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    if (state.status === 'loading') load();
  }, [load]);
  return { ...snapshot, error, retry: load };
}
