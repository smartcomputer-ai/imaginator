import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { commandNames, type ImaginatorEvent } from '@imaginator/core';
import type { AssetStore } from '../assets/store.js';
import type { CommandRegistry } from '../commands/registry.js';
import { ServiceError } from '../errors.js';
import type { EventBus } from '../events/bus.js';
import type { McpHttp } from '../mcp/http.js';
import type { Services } from '../services/index.js';
import type { AuthConfig } from '../config.js';
import { createAuth, type Principal } from './auth.js';

export interface HttpDeps {
  commands: CommandRegistry;
  services: Services;
  bus: EventBus;
  store: AssetStore;
  /** MCP endpoint, mounted at /mcp when given. */
  mcp?: McpHttp;
  /** Directory of the built web app; served statically when it exists. */
  webDist?: string;
  /** Authenticated mode; undefined = open (localhost tool). */
  auth?: AuthConfig;
  log: (m: string) => void;
}

type Env = { Variables: { principal?: Principal } };

export interface HttpApp {
  hono: Hono<Env>;
  fetch: Hono<Env>['fetch'];
  /** Close every open SSE stream (shutdown). */
  closeStreams(): void;
}

const CACHE_FOREVER = 'public, max-age=31536000, immutable';

function errorResponse(c: Context, e: unknown): Response {
  if (e instanceof ServiceError) {
    return c.json({ error: { message: e.message, code: e.code, ...(e.issues ? { issues: e.issues } : {}) } }, e.status as 400);
  }
  const message = e instanceof Error ? e.message : String(e);
  return c.json({ error: { message, code: 'internal' } }, 500);
}

/** Query params → command input: values that look like JSON are parsed. */
function queryToInput(query: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    if (/^(\{|\[|"|-?\d|true$|false$|null$)/.test(v)) {
      try {
        out[k] = JSON.parse(v);
        continue;
      } catch {
        /* fall through to string */
      }
    }
    out[k] = v;
  }
  return out;
}

const isSecure = (c: Context) => c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';

export function createHttpApp(deps: HttpDeps): HttpApp {
  const app = new Hono<Env>();
  const streams = new Set<() => void>();
  const auth = deps.auth ? createAuth(deps.auth) : undefined;

  app.use('*', cors({ origin: (origin) => origin || '*', credentials: false, exposeHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'] }));
  app.onError((e, c) => {
    if (!(e instanceof ServiceError)) deps.log(`http error ${c.req.method} ${c.req.path}: ${e.stack ?? e.message}`);
    return errorResponse(c, e);
  });

  // -- auth -------------------------------------------------------------------------
  // Everything under /api, /assets and /mcp needs a credential in authenticated
  // mode: the session cookie (web login) or `Authorization: Bearer <AUTH_API_KEY>`
  // (MCP clients, scripts). Health, the auth routes and the static web app stay open.
  if (auth) {
    app.use('*', async (c, next) => {
      const { pathname } = new URL(c.req.url);
      const guarded = pathname.startsWith('/api/') || pathname === '/api' || pathname.startsWith('/assets/') || pathname === '/mcp';
      const open = pathname === '/api/health' || pathname.startsWith('/api/auth/') || c.req.method === 'OPTIONS';
      if (!guarded || open) return next();
      const principal = auth.authenticate(c.req.raw);
      if (!principal) {
        const headers = { 'WWW-Authenticate': 'Bearer realm="imaginator"' };
        if (pathname === '/mcp') {
          return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: send `Authorization: Bearer <AUTH_API_KEY>`' }, id: null }, 401, headers);
        }
        return c.json({ error: { message: 'authentication required', code: 'unauthorized' } }, 401, headers);
      }
      c.set('principal', principal);
      return next();
    });
  }

  app.get('/api/auth/status', (c) => {
    if (!auth) return c.json({ enabled: false, authenticated: true });
    const principal = auth.authenticate(c.req.raw);
    return c.json({ enabled: true, authenticated: !!principal, ...(principal ? { via: principal } : {}) });
  });

  app.post('/api/auth/login', async (c) => {
    if (!auth) return c.json({ ok: true, enabled: false });
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    if (!auth.checkPassword(password)) {
      const delay = auth.loginFailed();
      deps.log(`auth: failed login (next attempt delayed ${delay}ms)`);
      await new Promise((r) => setTimeout(r, delay));
      throw new ServiceError('unauthorized', 'wrong password');
    }
    auth.loginSucceeded();
    const { token, exp } = auth.issueSession();
    c.header('Set-Cookie', auth.sessionCookie(token, exp, isSecure(c)));
    return c.json({ ok: true, enabled: true, expiresAt: new Date(exp).toISOString() });
  });

  app.post('/api/auth/logout', (c) => {
    if (auth) c.header('Set-Cookie', auth.clearCookie(isSecure(c)));
    return c.json({ ok: true });
  });

  app.get('/api/health', (c) => c.json({ ok: true, bootId: deps.bus.bootId }));

  // -- Self-describing index: every command with its JSON schemas -----------------
  app.get('/api', (c) => {
    const commands = commandNames.map((name) => {
      const def = deps.commands[name];
      const toSchema = (schema: z.ZodTypeAny) => {
        try {
          return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
        } catch {
          return { description: 'schema not representable' };
        }
      };
      return {
        name,
        kind: def.kind,
        description: def.description,
        http: def.kind === 'read' ? [`POST /api/${name}`, `GET /api/${name}?<params>`] : [`POST /api/${name}`],
        input: toSchema(def.input),
        output: toSchema(def.output),
      };
    });
    return c.json({
      commands,
      auth: auth
        ? 'enabled: send `Authorization: Bearer <AUTH_API_KEY>` (MCP, scripts) or log in with POST /api/auth/login { password } for a session cookie (web)'
        : 'disabled',
      other: {
        'GET /api/health': 'liveness + bootId',
        'GET /api/auth/status': '{ enabled, authenticated, via? }',
        'POST /api/auth/login { password }': 'sets the session cookie (authenticated mode)',
        'POST /api/auth/logout': 'clears the session cookie',
        'GET /api/events?collection=<slug>': 'server-sent events: hello, then ImaginatorEvent per line',
        'POST|GET|DELETE /mcp': 'MCP over Streamable HTTP (tools, resources, prompts)',
        'POST /api/assets.upload (multipart/form-data: file, label?)': 'file upload alternative to the JSON form',
        'GET /assets/:id': 'original asset bytes',
        'GET /assets/:id/thumb': 'webp thumbnail',
      },
      errors: '{ error: { message, code, issues? } } with 400 validation / 404 not found / 409 conflict / 500',
    });
  });

  // -- MCP (Streamable HTTP) ------------------------------------------------------
  if (deps.mcp) {
    const mcp = deps.mcp;
    app.all('/mcp', (c) => mcp.handle(c.req.raw));
  }

  // -- SSE ------------------------------------------------------------------------
  app.get('/api/events', (c) => {
    const collection = c.req.query('collection');
    return streamSSE(c, async (stream) => {
      let done!: () => void;
      const closed = new Promise<void>((r) => (done = r));
      const forward = (e: ImaginatorEvent) => {
        if (collection && 'collection' in e && e.collection !== collection) return;
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => done());
      };
      const unsubscribe = deps.bus.on(forward);
      const ping = setInterval(() => void stream.write(': ping\n\n').catch(() => done()), 15_000);
      const close = () => {
        unsubscribe();
        clearInterval(ping);
        streams.delete(close);
        done();
      };
      streams.add(close);
      stream.onAbort(close);
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ bootId: deps.bus.bootId }) });
      await closed;
      close();
    });
  });

  // -- commands --------------------------------------------------------------------
  for (const name of commandNames) {
    const command = deps.commands[name];
    app.post(`/api/${name}`, async (c) => {
      let input: unknown = {};
      const contentType = c.req.header('content-type') ?? '';
      if (name === 'assets.upload' && contentType.startsWith('multipart/form-data')) {
        const body = await c.req.parseBody();
        const file = body.file;
        if (!(file instanceof File)) throw new ServiceError('validation', 'multipart upload needs a `file` field');
        const bytes = Buffer.from(await file.arrayBuffer()).toString('base64');
        input = { bytes, ...(file.type ? { mime: file.type } : {}), ...(typeof body.label === 'string' ? { label: body.label } : {}) };
      } else if (contentType.includes('json')) {
        input = await c.req.json().catch(() => {
          throw new ServiceError('validation', 'body must be JSON');
        });
      } else {
        const text = await c.req.text();
        if (text.trim()) {
          try {
            input = JSON.parse(text);
          } catch {
            throw new ServiceError('validation', 'body must be JSON');
          }
        }
      }
      return c.json(await command.run(input));
    });
    if (command.kind === 'read') {
      app.get(`/api/${name}`, async (c) => c.json(await command.run(queryToInput(c.req.query()))));
    }
  }

  // -- assets -----------------------------------------------------------------------
  const sendFile = (c: Context, filePath: string, mime: string) => {
    const stat = fs.statSync(filePath);
    const body = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream;
    return c.body(body, 200, { 'Content-Type': mime, 'Content-Length': String(stat.size), 'Cache-Control': CACHE_FOREVER });
  };

  app.get('/assets/:id', (c) => {
    const row = deps.services.assets.getRow(c.req.param('id'));
    if (!row) throw new ServiceError('not_found', `asset ${c.req.param('id')} not found`);
    const p = deps.store.originalPath(row.id, row.ext);
    if (!fs.existsSync(p)) throw new ServiceError('storage', `asset ${row.id} original is missing on disk`);
    return sendFile(c, p, row.mime);
  });

  app.get('/assets/:id/thumb', async (c) => {
    const row = deps.services.assets.getRow(c.req.param('id'));
    if (!row) throw new ServiceError('not_found', `asset ${c.req.param('id')} not found`);
    const thumb = await deps.store.ensureThumb(row.id, row.ext);
    return sendFile(c, thumb, 'image/webp');
  });

  // -- static web app ------------------------------------------------------------------
  const dist = deps.webDist;
  if (dist && fs.existsSync(path.join(dist, 'index.html'))) {
    const MIME: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.map': 'application/json',
      '.txt': 'text/plain',
      '.webp': 'image/webp',
    };
    app.get('*', (c) => {
      const url = new URL(c.req.url);
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/assets/') || url.pathname === '/mcp') return c.notFound();
      const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      const candidate = path.join(dist, rel);
      if (candidate.startsWith(dist) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const mime = MIME[path.extname(candidate)] ?? 'application/octet-stream';
        const cache = rel.startsWith(`${path.sep}assets${path.sep}`) ? CACHE_FOREVER : 'no-cache';
        const stat = fs.statSync(candidate);
        return c.body(Readable.toWeb(fs.createReadStream(candidate)) as ReadableStream, 200, { 'Content-Type': mime, 'Content-Length': String(stat.size), 'Cache-Control': cache });
      }
      return c.html(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), 200, { 'Cache-Control': 'no-cache' });
    });
  }

  app.notFound((c) => c.json({ error: { message: `no route for ${c.req.method} ${new URL(c.req.url).pathname}`, code: 'not_found' } }, 404));

  return {
    hono: app,
    fetch: app.fetch,
    closeStreams: () => {
      for (const close of [...streams]) close();
    },
  };
}
