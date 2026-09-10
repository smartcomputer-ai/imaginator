/**
 * stdio bridge for clients that only launch local MCP servers (Claude Desktop
 * config files, `claude mcp add imaginator -- pnpm mcp`, etc.). It does not
 * run the engine: it forwards JSON-RPC verbatim to the running server's
 * Streamable HTTP endpoint, so there is exactly one process owning the
 * database and the runner. Works for both the 2025-era (initialize + session)
 * and the 2026-07-28 (stateless envelope) protocol revisions, because it
 * never interprets the messages.
 *
 *   IMAGINATOR_SERVER_URL=http://127.0.0.1:4747 pnpm mcp
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { StreamableHTTPClientTransport, type JSONRPCMessage } from '@modelcontextprotocol/client';
import { loadDotenv } from '../config.js';

loadDotenv();

const port = process.env.IMAGINATOR_PORT ?? '4747';
const base = (process.env.IMAGINATOR_SERVER_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const endpoint = new URL(`${base}/mcp`);

const log = (m: string) => process.stderr.write(`[imaginator mcp] ${m}\n`);

const health = await fetch(`${base}/api/health`).catch(() => undefined);
if (!health?.ok) {
  log(`no imaginator server at ${base}; start it first (pnpm dev:server or ./run.sh) or set IMAGINATOR_SERVER_URL`);
  process.exit(1);
}

const upstream = new StreamableHTTPClientTransport(endpoint);
const local = new StdioServerTransport();

let closing = false;
const shutdown = async (why: string) => {
  if (closing) return;
  closing = true;
  log(why);
  await Promise.all([upstream.close().catch(() => {}), local.close().catch(() => {})]);
  process.exit(0);
};

local.onmessage = (message: JSONRPCMessage) => {
  upstream.send(message).catch((e: unknown) => {
    log(`upstream send failed: ${(e as Error).message}`);
    // Surface the failure to the client instead of hanging the request.
    if ('id' in message && 'method' in message) {
      void local.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `imaginator server unreachable: ${(e as Error).message}` } });
    }
  });
};
upstream.onmessage = (message: JSONRPCMessage) => {
  // A 2025-era initialize result carries the negotiated version; the HTTP transport echoes it as a header afterwards.
  if ('result' in message && message.result && typeof message.result === 'object' && 'protocolVersion' in message.result) {
    const v = (message.result as { protocolVersion?: unknown }).protocolVersion;
    if (typeof v === 'string') upstream.setProtocolVersion?.(v);
  }
  void local.send(message);
};
local.onclose = () => void shutdown('stdin closed');
upstream.onclose = () => void shutdown('server connection closed');
upstream.onerror = (e) => log(`upstream error: ${e.message}`);
local.onerror = (e) => log(`stdio error: ${e.message}`);

await upstream.start();
await local.start();
log(`bridging stdio ↔ ${endpoint.href}`);
