import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type ClientOptions,
  type ImageContent,
  type ResourceLink,
  type TextContent,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { App } from '../src/app.js';
import { REPO_ROOT } from '../src/config.js';
import { pngBase64 } from './fixtures.js';
import { bootApp, settle } from './helpers.js';

const MODERN = '2026-07-28';

let app: App;
const clients: Client[] = [];
const transports = new WeakMap<Client, StreamableHTTPClientTransport>();
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await app?.stop();
});

/** Default = 2025-era (initialize + session); `modern` pins the 2026-07-28 envelope protocol. */
async function connect(base: string, opts: { modern?: boolean } = {}): Promise<Client> {
  const options: ClientOptions = opts.modern ? { versionNegotiation: { mode: { pin: MODERN } } } : {};
  const client = new Client({ name: 'test', version: '0.0.0' }, options);
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  await client.connect(transport);
  clients.push(client);
  transports.set(client, transport);
  return client;
}

function structured<T = Record<string, unknown>>(r: CallToolResult): T {
  expect(r.isError).toBeFalsy();
  return r.structuredContent as T;
}
const texts = (r: CallToolResult) => r.content.filter((c): c is TextContent => c.type === 'text').map((c) => c.text);
const images = (r: CallToolResult) => r.content.filter((c): c is ImageContent => c.type === 'image');
const links = (r: CallToolResult) => r.content.filter((c): c is ResourceLink => c.type === 'resource_link');

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return client.callTool({ name, arguments: args });
}

async function waitUntilIdle(client: Client, collection: string, cursor: string, onprogress?: (message: string) => void): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const r = await client.callTool(
      { name: 'wait_for_collection', arguments: { collection, cursor, timeoutMs: 5000 } },
      onprogress ? { onprogress: (p) => onprogress(p.message ?? '') } : undefined,
    );
    const w = structured<{ cursor: string; inFlight: number; queued: number }>(r);
    cursor = w.cursor;
    if (w.inFlight === 0 && w.queued === 0) return cursor;
  }
  throw new Error('collection never settled');
}

describe('mcp', () => {
  it('exposes tools, resources, and prompts to a 2025-era client', async () => {
    app = await bootApp();
    const base = await app.listen(0);
    const client = await connect(base);
    expect(client.getServerVersion()?.name).toBe('imaginator');
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(client.getInstructions()).toMatch(/collection/);
    expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'add_columns', 'add_rows', 'cancel_cell', 'create_collection', 'delete_collection', 'get_asset', 'get_cell', 'get_collection',
        'get_generation', 'list_assets', 'list_collections', 'list_models', 'regenerate_cell', 'remove_column', 'remove_rows',
        'retry_cell', 'update_collection', 'update_column', 'update_row', 'upload_asset', 'view_images', 'wait_for_collection',
      ].sort(),
    );
    // UI-only operations are deliberately absent.
    expect(names.some((n) => /reorder|rename|duplicate|import|export|gc/.test(n))).toBe(false);
    for (const t of tools.tools) {
      expect(t.annotations?.readOnlyHint).toBeDefined();
      expect(t.inputSchema.type).toBe('object');
      expect(t.outputSchema?.type).toBe('object');
    }
    expect(tools.tools.find((t) => t.name === 'delete_collection')?.annotations?.destructiveHint).toBe(true);

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(
      ['imaginator://assets/{id}', 'imaginator://assets/{id}/thumb', 'imaginator://collections/{slug}'].sort(),
    );
    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain('imaginator://models');
    expect(resources.resources.map((r) => r.uri)).toContain('imaginator://collections');

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(['compare-models']);
    const prompt = await client.getPrompt({ name: 'compare-models', arguments: { prompts: 'a cat\na dog', models: 'mock/fast' } });
    expect(prompt.messages[0]?.content).toMatchObject({ type: 'text' });
    expect((prompt.messages[0]?.content as TextContent).text).toContain('mock/fast');

    const models = structured<{ models: { id: string }[] }>(await call(client, 'list_models'));
    expect(models.models.map((m) => m.id)).toContain('mock/fast');
  });

  it('drives the whole loop: create → wait (with progress) → get → view images → iterate', async () => {
    app = await bootApp();
    const base = await app.listen(0);
    const client = await connect(base);

    const created = structured<{ slug: string; cursor: string; cells: unknown[] }>(
      await call(client, 'create_collection', {
        slug: 'mcp',
        columns: [{ model: 'mock/fast' }, { model: 'mock/fast', id: 'fast-hue', settings: { hue: 200 } }],
        rows: [{ prompt: 'one' }, { prompt: 'two' }],
      }),
    );
    expect(created.cells).toHaveLength(4);

    const progress: string[] = [];
    const cursor = await waitUntilIdle(client, 'mcp', created.cursor, (m) => progress.push(m));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toMatch(/succeeded/);

    const got = await call(client, 'get_collection', { collection: 'mcp' });
    const view = structured<{ cells: { address: string; status: string; outputs: string[] }[] }>(got);
    expect(view.cells.every((c) => c.status === 'succeeded')).toBe(true);
    expect(images(got)).toHaveLength(0);
    expect(JSON.parse(texts(got)[0]!).slug).toBe('mcp');

    const withImages = await call(client, 'get_collection', { collection: 'mcp', images: true });
    expect(images(withImages)).toHaveLength(4);
    expect(images(withImages)[0]?.mimeType).toBe('image/webp');
    expect(texts(withImages).some((t) => t.startsWith('mcp/r1/fast: asset'))).toBe(true);

    const cell = await call(client, 'get_cell', { cell: 'mcp/r1/fast' });
    const cellOut = structured<{ cell: { outputs: string[] }; current: { status: string }; versions: unknown[] }>(cell);
    expect(cellOut.current.status).toBe('succeeded');
    expect(images(cell)).toHaveLength(1);
    const noImages = await call(client, 'get_cell', { cell: 'mcp/r1/fast', images: false });
    expect(images(noImages)).toHaveLength(0);
    expect(links(noImages)).toHaveLength(1);
    expect(links(noImages)[0]?.uri).toBe(`imaginator://assets/${cellOut.cell.outputs[0]}`);
    expect(links(noImages)[0]?.description).toContain(`${base}/assets/`);

    const assetId = cellOut.cell.outputs[0]!;
    const viewed = await call(client, 'view_images', { refs: ['mcp/r1/fast', 'mcp/r2/fast-hue#1', assetId], size: 'full' });
    expect(images(viewed)).toHaveLength(3);
    expect(images(viewed)[0]?.mimeType).toBe('image/png');
    const labels = texts(viewed);
    expect(labels[0]).toMatch(/^3 image\(s\)/);
    expect(labels[1]).toMatch(/^mcp\/r1\/fast#1 \(succeeded\): asset/);
    expect(labels[2]).toMatch(/^mcp\/r2\/fast-hue#1 \(succeeded\): asset/);
    expect(labels[3]).toMatch(new RegExp(`^${assetId}: asset ${assetId}`));

    // Iterate: one row edit → only that row regenerates.
    const updated = structured<{ cursor: string }>(await call(client, 'update_row', { collection: 'mcp', row: 'r1', prompt: 'one, revised' }));
    expect(updated.cursor).not.toBe(cursor);
    await settle(app, 'mcp');
    const after = structured<{ cells: { address: string; version: number }[] }>(await call(client, 'get_collection', { collection: 'mcp' }));
    expect(after.cells.find((c) => c.address === 'mcp/r1/fast')?.version).toBe(2);
    expect(after.cells.find((c) => c.address === 'mcp/r2/fast')?.version).toBe(1);

    const regen = structured<{ generation: { forced: boolean } }>(await call(client, 'regenerate_cell', { cell: 'mcp/r2/fast' }));
    expect(regen.generation.forced).toBe(true);

    // Pause via update_collection folds two commands into one tool.
    const paused = structured<{ status: string }>(await call(client, 'update_collection', { collection: 'mcp', status: 'paused', title: 'Paused' }));
    expect(paused.status).toBe('paused');
    const summary = structured<{ collections: { slug: string; title: string; status: string }[] }>(await call(client, 'list_collections'));
    expect(summary.collections[0]).toMatchObject({ slug: 'mcp', title: 'Paused', status: 'paused' });
  });

  it('serves resources, completes template variables, and pushes updates to 2025-era subscribers', async () => {
    app = await bootApp();
    const base = await app.listen(0);
    const client = await connect(base);

    const updates: string[] = [];
    client.setNotificationHandler('notifications/resources/updated', (n) => {
      updates.push(n.params.uri);
    });
    await client.subscribeResource({ uri: 'imaginator://collections/res' });

    await call(client, 'create_collection', { slug: 'res', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'x' }] });
    await settle(app, 'res');
    await new Promise((r) => setTimeout(r, 400));
    expect(updates).toContain('imaginator://collections/res');

    const listed = await client.listResources();
    expect(listed.resources.find((r) => r.uri === 'imaginator://collections/res')?.mimeType).toBe('application/json');
    const doc = await client.readResource({ uri: 'imaginator://collections/res' });
    const json = JSON.parse((doc.contents[0] as { text: string }).text);
    expect(json.cells[0].status).toBe('succeeded');
    const assetId = json.cells[0].outputs[0] as string;

    const original = await client.readResource({ uri: `imaginator://assets/${assetId}` });
    expect(original.contents[0]?.mimeType).toBe('image/png');
    expect(Buffer.from((original.contents[0] as { blob: string }).blob, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const thumb = await client.readResource({ uri: `imaginator://assets/${assetId}/thumb` });
    expect(thumb.contents[0]?.mimeType).toBe('image/webp');
    expect(listed.resources.find((r) => r.uri === `imaginator://assets/${assetId}`)?.mimeType).toBe('image/png');

    const completion = await client.complete({ ref: { type: 'ref/resource', uri: 'imaginator://collections/{slug}' }, argument: { name: 'slug', value: 'r' } });
    expect(completion.completion.values).toEqual(['res']);

    await client.unsubscribeResource({ uri: 'imaginator://collections/res' });
    await expect(client.readResource({ uri: 'imaginator://collections/nope' })).rejects.toThrow(/not found/);
  });

  it('serves the 2026-07-28 protocol on the same endpoint: stateless tools, progress, and listen subscriptions', async () => {
    app = await bootApp();
    const base = await app.listen(0);
    const client = await connect(base, { modern: true });
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    expect(client.getServerVersion()?.name).toBe('imaginator');
    expect(app.mcp.sessionCount()).toBe(0);

    const updates: string[] = [];
    client.setNotificationHandler('notifications/resources/updated', (n) => {
      updates.push(n.params.uri);
    });
    const subscription = await client.listen({ resourceSubscriptions: ['imaginator://collections/modern'], resourcesListChanged: true });
    expect(subscription.honoredFilter.resourceSubscriptions).toContain('imaginator://collections/modern');

    const created = structured<{ cursor: string }>(await call(client, 'create_collection', { slug: 'modern', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'hi' }] }));
    const progress: string[] = [];
    await waitUntilIdle(client, 'modern', created.cursor, (m) => progress.push(m));
    expect(progress.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 400));
    expect(updates).toContain('imaginator://collections/modern');
    await subscription.close();

    const cell = await call(client, 'get_cell', { cell: 'modern/r1/fast' });
    expect(images(cell)).toHaveLength(1);
    const doc = await client.readResource({ uri: 'imaginator://collections/modern' });
    expect(JSON.parse((doc.contents[0] as { text: string }).text).cells[0].status).toBe('succeeded');
    expect(app.mcp.sessionCount()).toBe(0);
  });

  it('uploads assets, reports command errors as tool errors, and manages 2025-era sessions', async () => {
    app = await bootApp();
    const base = await app.listen(0);
    const client = await connect(base);

    const up = await call(client, 'upload_asset', { bytes: await pngBase64(64, 48), label: 'ref' });
    const asset = structured<{ asset: { id: string; label: string } }>(up).asset;
    expect(asset.label).toBe('ref');
    expect(links(up)[0]?.title).toBe('ref');
    const got = await call(client, 'get_asset', { asset: asset.id });
    expect(images(got)).toHaveLength(1);

    // Schema violations are caught by the SDK before the handler (JSON-RPC -32602); the client surfaces them as an error result.
    const bad = await call(client, 'create_collection', { slug: 'Not A Slug' });
    expect(bad.isError).toBe(true);
    expect(texts(bad)[0]).toMatch(/create_collection/);
    // Refinements the JSON schema cannot express reach the command layer and come back as `validation:`.
    const twoSources = await call(client, 'upload_asset', { bytes: 'aGk=', url: 'http://127.0.0.1:1/x.png' });
    expect(twoSources.isError).toBe(true);
    expect(texts(twoSources)[0]).toMatch(/exactly one of bytes, path, url/);
    const missing = await call(client, 'get_cell', { cell: 'nope/r1/x' });
    expect(missing.isError).toBe(true);
    expect(texts(missing)[0]).toMatch(/^not_found:/);
    const badRef = await call(client, 'view_images', { refs: ['what?'] });
    expect(badRef.isError).toBe(true);

    // Sessions: unknown ids are rejected so clients re-initialize; DELETE closes.
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const listBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'mcp-session-id': 'nope' }, body: listBody });
    expect(res.status).toBe(404);
    const noInit = await fetch(`${base}/mcp`, { method: 'POST', headers, body: listBody });
    expect(noInit.status).toBe(400);
    expect(app.mcp.sessionCount()).toBe(1);
    await transports.get(client)!.terminateSession();
    expect(app.mcp.sessionCount()).toBe(0);
  });

  it('bridges stdio to the running server', async () => {
    app = await bootApp();
    const base = await app.listen(0);
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, 'packages', 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO_ROOT, 'packages', 'server', 'src', 'mcp', 'stdio.ts')],
      env: { ...process.env, IMAGINATOR_SERVER_URL: base } as Record<string, string>,
      stderr: 'pipe',
    });
    await client.connect(transport);
    clients.push(client);
    expect(client.getServerVersion()?.name).toBe('imaginator');
    const models = structured<{ models: { id: string }[] }>(await call(client, 'list_models'));
    expect(models.models.length).toBeGreaterThan(0);
    const created = structured<{ cursor: string }>(await call(client, 'create_collection', { slug: 'stdio', columns: [{ model: 'mock/fast' }], rows: [{ prompt: 'hi' }] }));
    const waited = structured<{ changed: boolean }>(await call(client, 'wait_for_collection', { collection: 'stdio', cursor: created.cursor, timeoutMs: 10_000 }));
    expect(waited.changed).toBe(true);
    expect(app.mcp.sessionCount()).toBe(1);
  }, 30_000);
});
