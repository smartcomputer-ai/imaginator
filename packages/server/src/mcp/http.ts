import { randomUUID } from 'node:crypto';
import {
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isInitializeRequest,
  isLegacyRequest,
  type McpHttpHandler,
  type McpServer,
} from '@modelcontextprotocol/server';
import type { ImaginatorEvent } from '@imaginator/core';
import { URI, createMcpServer, type McpDeps } from './server.js';

export interface McpHttp {
  /** Handle one request to the MCP endpoint: 2026-07-28 traffic and 2025-era sessions alike. */
  handle(req: Request): Promise<Response>;
  /** Number of live 2025-era sessions. */
  sessionCount(): number;
  /** Close every session and the modern handler (shutdown). */
  closeAll(): Promise<void>;
}

interface Session {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
}

export interface McpHttpOptions {
  /** 2025-era sessions idle longer than this are closed by the sweeper. Default 2h; 0 disables. */
  idleMs?: number;
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * One endpoint, two protocol eras:
 *
 * - **2026-07-28** requests (they carry the `_meta` envelope) go to the SDK's
 *   `createMcpHandler`: stateless per request, `subscriptions/listen` streams
 *   fed from the handler's event bus, progress on the response stream.
 * - **2025-era** requests (`initialize` + `Mcp-Session-Id`) get a stateful
 *   session each, one `McpServer` per session, so the standalone GET stream
 *   can carry `notifications/resources/updated` to clients that subscribe.
 *
 * `isLegacyRequest` is the SDK's own classifier, so routing matches what the
 * modern handler would decide itself.
 */
export function createMcpHttp(deps: McpDeps, options: McpHttpOptions = {}): McpHttp {
  const sessions = new Map<string, Session>();
  const idleMs = options.idleMs ?? 2 * 60 * 60 * 1000;

  // -- modern (2026-07-28) ----------------------------------------------------------
  const modern: McpHttpHandler = createMcpHandler(() => createMcpServer(deps, { legacySubscriptions: false }), {
    legacy: 'reject',
    onerror: (e) => deps.log(`mcp: ${e.message}`),
  });

  // Collection resources follow the event bus; coalesce bursts per URI.
  const pending = new Map<string, NodeJS.Timeout>();
  const publishUpdated = (uri: string) => {
    if (pending.has(uri)) return;
    pending.set(
      uri,
      setTimeout(() => {
        pending.delete(uri);
        modern.notify.resourceUpdated(uri);
      }, 250),
    );
  };
  const unsubscribe = deps.bus.on((e: ImaginatorEvent) => {
    if ('collection' in e) {
      publishUpdated(URI.collection(e.collection));
      publishUpdated(URI.collections);
      if (e.type === 'collection.created' || e.type === 'collection.deleted') modern.notify.resourcesChanged();
    } else if (e.type === 'asset.created') {
      modern.notify.resourcesChanged();
    }
  });

  // -- legacy (2025-era) sessions -----------------------------------------------------
  const sweeper =
    idleMs > 0
      ? setInterval(() => {
          const cutoff = Date.now() - idleMs;
          for (const [id, s] of sessions) if (s.lastSeen < cutoff) void closeSession(id);
        }, Math.min(idleMs, 10 * 60 * 1000))
      : undefined;
  sweeper?.unref();

  async function closeSession(id: string): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.transport.close().catch(() => {});
    await s.server.close().catch(() => {});
  }

  async function startSession(req: Request, body: unknown): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport, lastSeen: Date.now() });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    const server = createMcpServer(deps, { legacySubscriptions: true });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      void server.close().catch(() => {});
    };
    await server.connect(transport);
    return transport.handleRequest(req, { parsedBody: body });
  }

  async function handleLegacy(req: Request, body: unknown): Promise<Response> {
    const sessionId = req.headers.get('mcp-session-id');
    if (sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return jsonRpcError(404, -32001, 'Session not found; send a new initialize request');
      s.lastSeen = Date.now();
      return s.transport.handleRequest(req, body === undefined ? undefined : { parsedBody: body });
    }
    if (req.method !== 'POST') return jsonRpcError(400, -32000, 'Mcp-Session-Id header required');
    const isInit = Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);
    if (!isInit) return jsonRpcError(400, -32000, 'Bad Request: no session; send an initialize request first');
    return startSession(req, body);
  }

  return {
    async handle(req) {
      let body: unknown;
      if (req.method === 'POST') {
        try {
          body = await req.json();
        } catch {
          return jsonRpcError(400, -32700, 'Parse error: body must be JSON');
        }
      }
      if (await isLegacyRequest(req, body)) return handleLegacy(req, body);
      return modern.fetch(req, body === undefined ? undefined : { parsedBody: body });
    },
    sessionCount: () => sessions.size,
    async closeAll() {
      if (sweeper) clearInterval(sweeper);
      unsubscribe();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      await Promise.all([...sessions.keys()].map(closeSession));
      await modern.close().catch(() => {});
    },
  };
}
