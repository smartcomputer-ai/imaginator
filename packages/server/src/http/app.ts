import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { commandNames, type ImaginatorEvent } from '@imaginator/core';
import type { AssetStore } from '../assets/store.js';
import type { CommandRegistry } from '../commands/registry.js';
import { ServiceError } from '../errors.js';
import type { EventBus } from '../events/bus.js';
import type { Services } from '../services/index.js';

export interface HttpDeps {
  commands: CommandRegistry;
  services: Services;
  bus: EventBus;
  store: AssetStore;
  /** Directory of the built web app; served statically when it exists. */
  webDist?: string;
  log: (m: string) => void;
}

export interface HttpApp {
  hono: Hono;
  fetch: Hono['fetch'];
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

export function createHttpApp(deps: HttpDeps): HttpApp {
  const app = new Hono();
  const streams = new Set<() => void>();

  app.use('*', cors({ origin: (origin) => origin || '*', credentials: false }));
  app.onError((e, c) => {
    if (!(e instanceof ServiceError)) deps.log(`http error ${c.req.method} ${c.req.path}: ${e.stack ?? e.message}`);
    return errorResponse(c, e);
  });

  app.get('/api/health', (c) => c.json({ ok: true, bootId: deps.bus.bootId }));

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
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/assets/')) return c.notFound();
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
