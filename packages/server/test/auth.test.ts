import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { App } from '../src/app.js';
import { loadAuthConfig } from '../src/config.js';
import { createAuth } from '../src/http/auth.js';
import { bootApp } from './helpers.js';

const AUTH = { password: 'open-sesame', apiKey: 'k-123', sessionTtlMs: 60_000 };

let app: App;
afterEach(async () => {
  await app?.stop();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const json = async (res: Response) => ({ status: res.status, headers: res.headers, body: (await res.json()) as Json });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(json);

describe('config', () => {
  it('is off unless AUTH_ENABLED is set, and refuses to run half-configured', () => {
    expect(loadAuthConfig({})).toBeUndefined();
    expect(loadAuthConfig({ AUTH_ENABLED: '0', AUTH_PASSWORD: 'x', AUTH_API_KEY: 'y' })).toBeUndefined();
    expect(loadAuthConfig({ AUTH_ENABLED: '1', AUTH_PASSWORD: 'x', AUTH_API_KEY: 'y' })).toMatchObject({ password: 'x', apiKey: 'y' });
    expect(() => loadAuthConfig({ AUTH_ENABLED: 'true' })).toThrow(/AUTH_PASSWORD and AUTH_API_KEY/);
    expect(() => loadAuthConfig({ AUTH_ENABLED: 'true', AUTH_PASSWORD: 'x' })).toThrow(/AUTH_API_KEY is empty/);
  });
});

describe('session tokens', () => {
  it('verifies its own tokens, rejects expired or forged ones', () => {
    const auth = createAuth(AUTH);
    const { token } = auth.issueSession(1_000_000);
    const req = (cookie?: string, bearer?: string) =>
      new Request('http://x/api/collections.list', { headers: { ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });
    expect(auth.authenticate(req(`imaginator_session=${token}`))).toBeUndefined(); // expired long ago (exp = 1_000_000 + ttl)
    const live = auth.issueSession().token;
    expect(auth.authenticate(req(`other=1; imaginator_session=${live}`))).toBe('session');
    expect(auth.authenticate(req(`imaginator_session=${live.slice(0, -2)}xx`))).toBeUndefined();
    expect(auth.authenticate(req(undefined, 'k-123'))).toBe('apiKey');
    expect(auth.authenticate(req(undefined, 'k-124'))).toBeUndefined();
    expect(auth.authenticate(req())).toBeUndefined();
    // Sessions are bound to the secrets: a server with another password rejects them.
    expect(createAuth({ ...AUTH, password: 'other' }).authenticate(req(`imaginator_session=${live}`))).toBeUndefined();
  });
});

describe('http auth', () => {
  it('stays open when auth is disabled', async () => {
    app = await bootApp();
    const base = await app.listen(0);
    expect((await fetch(`${base}/api/auth/status`).then(json)).body).toEqual({ enabled: false, authenticated: true });
    expect((await fetch(`${base}/api/collections.list`)).status).toBe(200);
  });

  it('guards commands, assets, events and MCP; accepts the bearer key or a login cookie', async () => {
    app = await bootApp({ config: { auth: AUTH } });
    const base = await app.listen(0);
    const bearer = { authorization: 'Bearer k-123' };

    // Open routes.
    expect((await fetch(`${base}/api/health`).then(json)).body.ok).toBe(true);
    expect((await fetch(`${base}/api/auth/status`).then(json)).body).toEqual({ enabled: true, authenticated: false });

    // Guarded routes without a credential.
    const denied = await fetch(`${base}/api/collections.list`).then(json);
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe('unauthorized');
    expect(denied.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect((await post(`${base}/api/collections.create`, { slug: 'nope' })).status).toBe(401);
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
    expect((await fetch(`${base}/assets/abc123`)).status).toBe(401);
    expect((await fetch(`${base}/api`)).status).toBe(401);
    const mcpDenied = await post(`${base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(mcpDenied.status).toBe(401);
    expect(mcpDenied.body.error.code).toBe(-32001);
    expect((await fetch(`${base}/api/collections.list`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);

    // Bearer key.
    expect((await fetch(`${base}/api/auth/status`, { headers: bearer }).then(json)).body).toEqual({ enabled: true, authenticated: true, via: 'apiKey' });
    const created = await post(`${base}/api/collections.create`, { slug: 'auth', title: 'Auth' }, bearer);
    expect(created.status).toBe(200);

    // Login: wrong password is rejected (and delayed), right one sets an HttpOnly cookie.
    const wrong = await post(`${base}/api/auth/login`, { password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('unauthorized');
    const ok = await post(`${base}/api/auth/login`, { password: 'open-sesame' });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^imaginator_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Expires=/);
    const cookie = setCookie.split(';')[0]!;

    expect((await fetch(`${base}/api/auth/status`, { headers: { cookie } }).then(json)).body).toMatchObject({ authenticated: true, via: 'session' });
    const list = await fetch(`${base}/api/collections.list`, { headers: { cookie } }).then(json);
    expect(list.status).toBe(200);
    expect(list.body.collections.map((c: { slug: string }) => c.slug)).toEqual(['auth']);
    const events = await fetch(`${base}/api/events`, { headers: { cookie } });
    expect(events.status).toBe(200);
    expect(events.headers.get('content-type')).toMatch(/text\/event-stream/);
    await events.body?.cancel();
    // Missing asset is 404 (past the auth gate) rather than 401.
    expect((await fetch(`${base}/assets/abc123`, { headers: { cookie } })).status).toBe(404);

    // Logout clears the cookie.
    const out = await post(`${base}/api/auth/logout`, {}, { cookie });
    expect(out.headers.get('set-cookie')).toMatch(/^imaginator_session=; .*Max-Age=0/);
  });

  it('serves MCP to a client that sends the bearer key', async () => {
    app = await bootApp({ config: { auth: AUTH } });
    const base = await app.listen(0);

    const anonymous = new Client({ name: 'test', version: '0' });
    await expect(anonymous.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)))).rejects.toThrow(/Unauthorized/);

    const client = new Client({ name: 'test', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: 'Bearer k-123' } } });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('create_collection');
    await client.close();
  });
});
