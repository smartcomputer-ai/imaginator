import { z } from 'zod';
import {
  McpServer,
  ResourceTemplate,
  completable,
  type CallToolResult,
  type ContentBlock,
  type ReadResourceResult,
  type ResourceLink,
  type ServerContext,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import {
  RANDOM_ID_RE,
  assetViewSchema,
  cellViewSchema,
  collectionStatusSchema,
  collectionSlugSchema,
  columnIdSchema,
  columnInputSchema,
  columnSchema,
  commandDefs,
  commonSettingsSchema,
  cursorSchema,
  generationSchema,
  modelIdSchema,
  modelSettingsSchema,
  parseCellAddress,
  parseGenerationRef,
  rowIdSchema,
  rowInputSchema,
  rowSchema,
  type CommandName,
  type CommandOutput,
  type Generation,
  type ImaginatorEvent,
} from '@imaginator/core';
import type { AssetStore } from '../assets/store.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { AssetRow } from '../db/schema.js';
import { ServiceError } from '../errors.js';
import type { EventBus } from '../events/bus.js';
import type { Services } from '../services/index.js';
import { imageForModel, imageSizes, type ImageSize } from './images.js';

export interface McpDeps {
  commands: CommandRegistry;
  services: Services;
  store: AssetStore;
  bus: EventBus;
  /** Server version reported to clients. */
  version: string;
  /** Public HTTP base (e.g. http://127.0.0.1:4747) once listening; used for absolute asset URLs in text. */
  baseUrl: () => string | undefined;
  log: (m: string) => void;
}

export const MCP_SERVER_NAME = 'imaginator';

/**
 * Cap on inline images per tool result. Not a protocol limit: some clients
 * meter results by raw bytes, and 8 small images (~200 KB base64) is already
 * near what Claude Code accepts by default.
 */
export const MAX_IMAGES_PER_RESULT = 8;

// ---------------------------------------------------------------------------
// URIs
// ---------------------------------------------------------------------------

export const URI = {
  models: 'imaginator://models',
  collections: 'imaginator://collections',
  collection: (slug: string) => `imaginator://collections/${slug}`,
  asset: (id: string) => `imaginator://assets/${id}`,
  assetThumb: (id: string) => `imaginator://assets/${id}/thumb`,
} as const;

export interface McpServerOptions {
  /**
   * Serve `resources/subscribe` for a 2025-era session by forwarding the event
   * bus as `notifications/resources/updated`. Off for the stateless 2026-07-28
   * handler, whose `subscriptions/listen` streams are fed by the HTTP layer.
   */
  legacySubscriptions: boolean;
}

const INSTRUCTIONS = `Imaginator compares image generation models. A *collection* is a grid: rows are prompts (plus optional input images and common settings), columns are models (plus model settings). Nothing is imperative: adding rows or columns to a *live* collection is how you generate; the server fills every missing cell and skips cells whose content did not change.

Typical loop:
1. list_models to see what is available (ids look like provider/model).
2. create_collection with columns and rows in one call (or add_rows / add_columns later). Every mutation returns a cursor.
3. wait_for_collection(cursor) until inFlight and queued are both 0 (it returns early when anything changes; loop on it).
4. get_collection for the grid as data, then view_images (cell addresses, asset ids or generation refs) to actually look at results; get_cell for one cell with its version history.
5. Iterate: update_row changes a prompt (only that row regenerates), regenerate_cell asks for another sample, retry_cell re-runs a failed or unsupported cell.

Follow-up edits: give a row an input of { row: "r3", role: "init" } and its cell in each column edits that column's current output of r3, so a chain of edits reads top to bottom per model. Blocked cells wait for the referenced row.

Addresses: cells are collection/row/column (neon-cats/r3/flux-pro), generations are collection/row/column#version or a 6-character id, assets are 6-character ids usable as row inputs (upload_asset or a previous output). Resources mirror the same data: imaginator://collections/{slug} (JSON), imaginator://assets/{id} (image) and imaginator://assets/{id}/thumb.`;

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function text(t: string): ContentBlock {
  return { type: 'text', text: t };
}

function ok(structured: Record<string, unknown>, blocks: ContentBlock[] = [], summary?: string): CallToolResult {
  return {
    content: [text(summary ?? JSON.stringify(structured)), ...blocks],
    structuredContent: structured,
  };
}

function fail(e: unknown, log: (m: string) => void): CallToolResult {
  if (e instanceof ServiceError) {
    const issues = e.issues ? `\n${JSON.stringify(e.issues)}` : '';
    return { isError: true, content: [text(`${e.code}: ${e.message}${issues}`)] };
  }
  const message = e instanceof Error ? e.message : String(e);
  log(`mcp tool error: ${e instanceof Error ? (e.stack ?? message) : message}`);
  return { isError: true, content: [text(`internal: ${message}`)] };
}

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const IDEMPOTENT_WRITE: ToolAnnotations = { ...WRITE, idempotentHint: true };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createMcpServer(deps: McpDeps, options: McpServerOptions): McpServer {
  const { commands, services, store, bus, log } = deps;
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: deps.version, title: 'Imaginator', websiteUrl: deps.baseUrl() },
    {
      instructions: INSTRUCTIONS,
      // Advertised for both eras: 2026-07-28 `subscriptions/listen` honors resource subscriptions only when this bit is set.
      capabilities: { resources: { subscribe: true, listChanged: true } },
    },
  );

  const run = <N extends CommandName>(name: N, input: unknown): Promise<CommandOutput<N>> => commands[name].run(input) as Promise<CommandOutput<N>>;

  const httpUrl = (rel: string): string => {
    const base = deps.baseUrl();
    return base ? `${base}${rel}` : rel;
  };

  function assetLink(a: AssetRow, opts: { label?: string } = {}): ResourceLink {
    return {
      type: 'resource_link',
      uri: URI.asset(a.id),
      name: a.id,
      ...(a.label ? { title: a.label } : {}),
      mimeType: a.mime,
      size: a.bytes,
      description: `${opts.label ? `${opts.label} · ` : ''}${a.width}×${a.height} · ${httpUrl(`/assets/${a.id}`)}`,
    };
  }

  /** Label + image block for an asset; falls back to a link for non-image assets. */
  async function imageBlocks(assetId: string, label: string, size: ImageSize): Promise<ContentBlock[]> {
    const row = services.assets.getRow(assetId);
    if (!row) return [text(`${label}: asset ${assetId} not found`)];
    const img = await imageForModel(store, row, size);
    if (!img) return [text(`${label}: ${row.kind} asset ${assetId} (${row.mime}), not renderable inline`), assetLink(row)];
    return [text(`${label}: asset ${assetId} (${row.width}×${row.height} ${row.mime}, shown ${img.width}×${img.height})`), { type: 'image', data: img.data, mimeType: img.mimeType }];
  }

  function linkBlocks(assetIds: string[], label: string): ContentBlock[] {
    return assetIds.flatMap((id) => {
      const row = services.assets.getRow(id);
      return row ? [assetLink(row, { label })] : [];
    });
  }

  /** Resolve a free-form reference into (label, asset ids). */
  function resolveRef(ref: string): { label: string; assets: string[] } {
    const trimmed = ref.trim();
    if (RANDOM_ID_RE.test(trimmed)) {
      if (services.assets.getRow(trimmed)) return { label: trimmed, assets: [trimmed] };
      const g = services.generations.get({ id: trimmed });
      return { label: `${g.collection}/${g.row}/${g.column}#${g.version} (${g.status})`, assets: g.outputs };
    }
    if (trimmed.includes('#')) {
      const g = services.generations.get(parseGenerationRef(trimmed));
      return { label: `${g.collection}/${g.row}/${g.column}#${g.version} (${g.status})`, assets: g.outputs };
    }
    const cell = services.cells.get(parseCellAddress(trimmed));
    const suffix = cell.cell.version !== undefined ? `#${cell.cell.version}` : '';
    return { label: `${cell.cell.address}${suffix} (${cell.cell.status})`, assets: cell.cell.outputs };
  }

  type Handler<I> = (input: I, ctx: ServerContext) => Promise<CallToolResult>;
  function tool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    name: string,
    cfg: { title: string; description: string; input: I; output?: O; annotations: ToolAnnotations },
    handler: Handler<z.output<I>>,
  ): void {
    server.registerTool(
      name,
      {
        title: cfg.title,
        description: cfg.description,
        inputSchema: cfg.input,
        ...(cfg.output ? { outputSchema: cfg.output } : {}),
        annotations: cfg.annotations,
      },
      (async (args: unknown, ctx: ServerContext) => {
        try {
          return await handler(args as z.output<I>, ctx);
        } catch (e) {
          return fail(e, log);
        }
      }) as never,
    );
  }

  const collectionArg = collectionSlugSchema.describe('Collection slug');
  const cellArg = z.string().describe('Cell address: collection/row/column');
  const sizeArg = z
    .enum(imageSizes)
    .optional()
    .describe('small (≤512px webp, default; enough to judge composition), medium (≤800px), or full (original, downscaled above 1568px). Images cost context: use small unless you need detail.');
  const cursorOut = { cursor: cursorSchema };

  // -- models / collections (read) --------------------------------------------------

  tool(
    'list_models',
    {
      title: 'List models',
      description: 'List available models with capabilities (input roles, common keys, sizes) and their model-settings JSON schema.',
      input: z.object({}),
      output: commandDefs['models.list'].output,
      annotations: READ,
    },
    async () => ok(await run('models.list', {})),
  );

  tool(
    'list_collections',
    {
      title: 'List collections',
      description: 'List collections with status and cell counts (succeeded, in flight, queued, failed).',
      input: z.object({}),
      output: commandDefs['collections.list'].output,
      annotations: READ,
    },
    async () => ok(await run('collections.list', {})),
  );

  tool(
    'get_collection',
    {
      title: 'Get collection',
      description:
        'The whole grid as data: rows, columns, defaults, and every cell with status, output asset ids and version count. Set images=true to also see small images of the current outputs (capped; use view_images for a subset).',
      input: z.object({
        collection: collectionArg,
        images: z.boolean().optional().describe(`Inline a small image per current output (max ${MAX_IMAGES_PER_RESULT}). Default false.`),
      }),
      output: commandDefs['collections.get'].output,
      annotations: READ,
    },
    async ({ collection, images }) => {
      const view = await run('collections.get', { collection });
      const blocks: ContentBlock[] = [];
      if (images) {
        let shown = 0;
        let omitted = 0;
        for (const cell of view.cells) {
          for (const asset of cell.outputs) {
            if (shown >= MAX_IMAGES_PER_RESULT) {
              omitted++;
              continue;
            }
            blocks.push(...(await imageBlocks(asset, cell.address, 'small')));
            shown++;
          }
        }
        if (omitted > 0) blocks.push(text(`${omitted} more output(s) not shown; call view_images with specific cells.`));
      }
      return ok(view, blocks);
    },
  );

  tool(
    'wait_for_collection',
    {
      title: 'Wait for collection',
      description:
        'Block until something changes in the collection after the given cursor (or the timeout elapses). Returns the new cursor and how many generations are still queued or in flight. Loop: mutate → wait(cursor) → get, while inFlight or queued > 0. Progress notifications are sent when the client asks for them.',
      input: z.object({
        collection: collectionArg,
        cursor: cursorSchema.describe('Cursor returned by the last mutation or wait'),
        timeoutMs: z.number().int().min(0).max(120_000).optional().describe('Default 30000'),
      }),
      output: commandDefs['collections.wait'].output,
      annotations: READ,
    },
    async ({ collection, cursor, timeoutMs }, ctx) => {
      const token = ctx.mcpReq._meta?.progressToken;
      let ticker: NodeJS.Timeout | undefined;
      if (token !== undefined) {
        const report = () => {
          const summary = services.collections.list().find((c) => c.slug === collection);
          if (!summary) return;
          const done = summary.cells - summary.inFlight - summary.queued;
          void ctx.mcpReq
            .notify({
              method: 'notifications/progress',
              params: { progressToken: token, progress: done, total: summary.cells, message: `${summary.succeeded} succeeded, ${summary.inFlight} running, ${summary.queued} queued, ${summary.failed} failed` },
            })
            .catch(() => {});
        };
        report();
        ticker = setInterval(report, 2000);
      }
      try {
        const out = await run('collections.wait', { collection, cursor, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
        return ok(out);
      } finally {
        if (ticker) clearInterval(ticker);
      }
    },
  );

  // -- collections (write) ------------------------------------------------------------

  tool(
    'create_collection',
    {
      title: 'Create collection',
      description:
        'Create a collection, optionally with columns (models) and rows (prompts) in one call. Live by default, so rows × columns start generating immediately; pass status=paused to set things up first.',
      input: commandDefs['collections.create'].input,
      output: commandDefs['collections.create'].output,
      annotations: WRITE,
    },
    async (input) => ok(await run('collections.create', input)),
  );

  tool(
    'update_collection',
    {
      title: 'Update collection',
      description:
        'Change title, description, default common settings (replaced wholesale when given), or status. status=paused stops generation and cancels queued work; status=live resumes and fills every missing cell.',
      input: z.object({
        collection: collectionArg,
        title: z.string().optional(),
        description: z.string().nullable().optional(),
        defaults: commonSettingsSchema.optional(),
        status: collectionStatusSchema.optional(),
      }),
      output: commandDefs['collections.update'].output,
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ status, ...rest }) => {
      const hasFields = rest.title !== undefined || rest.description !== undefined || rest.defaults !== undefined;
      let view = hasFields ? await run('collections.update', rest) : undefined;
      if (status !== undefined) view = await run(status === 'paused' ? 'collections.pause' : 'collections.resume', { collection: rest.collection });
      return ok(view ?? (await run('collections.get', { collection: rest.collection })));
    },
  );

  tool(
    'delete_collection',
    {
      title: 'Delete collection',
      description: 'Delete a collection and its generations. Assets are kept (they may be inputs elsewhere).',
      input: z.object({ collection: collectionArg }),
      output: commandDefs['collections.delete'].output,
      annotations: DESTRUCTIVE,
    },
    async (input) => ok(await run('collections.delete', input)),
  );

  // -- columns ----------------------------------------------------------------------------

  tool(
    'add_columns',
    {
      title: 'Add columns',
      description: 'Add one or more columns (a model each, with optional model settings and output count). Every row gets a new cell per column.',
      input: z.object({ collection: collectionArg, columns: z.array(columnInputSchema).min(1) }),
      output: z.object({ columns: z.array(columnSchema), ...cursorOut }),
      annotations: WRITE,
    },
    async ({ collection, columns }) => {
      const added = [];
      let cursor = '';
      for (const c of columns) {
        const out = await run('columns.add', { collection, ...c });
        added.push(out.column);
        cursor = out.cursor;
      }
      return ok({ columns: added, cursor });
    },
  );

  tool(
    'update_column',
    {
      title: 'Update column',
      description: 'Change a column: rename (id), model, model settings (replaced wholesale; null clears), or count. Cells whose request changes regenerate.',
      input: z.object({
        collection: collectionArg,
        column: columnIdSchema,
        id: columnIdSchema.optional().describe('New column id'),
        model: modelIdSchema.optional(),
        settings: modelSettingsSchema.nullable().optional(),
        count: z.number().int().min(1).optional(),
      }),
      output: commandDefs['columns.update'].output,
      annotations: IDEMPOTENT_WRITE,
    },
    async (input) => ok(await run('columns.update', input)),
  );

  tool(
    'remove_column',
    {
      title: 'Remove column',
      description: 'Remove a column and its generations (assets are kept).',
      input: z.object({ collection: collectionArg, column: columnIdSchema }),
      output: commandDefs['columns.remove'].output,
      annotations: DESTRUCTIVE,
    },
    async (input) => ok(await run('columns.remove', input)),
  );

  // -- rows -----------------------------------------------------------------------------------

  tool(
    'add_rows',
    {
      title: 'Add rows',
      description:
        'Add one or more rows: prompt, optional negativePrompt, inputs, common settings (aspectRatio, size, seed, outputFormat), notes. Each row gets a cell per column. An input is either a fixed asset ({ asset, role }) or a row reference ({ row: "r3", role }) meaning "the current output of row r3 in the same column": that is how a follow-up edit chains on a previous row, per model. A cell whose referenced row has no output yet is blocked until it does; when the upstream cell gets a new current version the follow-up regenerates. Roles: reference, init, mask.',
      input: z.object({ collection: collectionArg, rows: z.array(rowInputSchema).min(1) }),
      output: commandDefs['rows.add'].output,
      annotations: WRITE,
    },
    async (input) => ok(await run('rows.add', input)),
  );

  tool(
    'update_row',
    {
      title: 'Update row',
      description:
        'Change a row. Only that row regenerates (plus rows that reference it), and only in columns where the resolved request changed. Nullable fields set to null are cleared; inputs and settings are replaced wholesale. paused=true stops the row from generating.',
      input: z.object({
        collection: collectionArg,
        row: rowIdSchema,
        prompt: z.string().optional(),
        negativePrompt: z.string().nullable().optional(),
        inputs: rowInputSchema.shape.inputs,
        settings: commonSettingsSchema.nullable().optional(),
        notes: z.string().nullable().optional(),
        paused: z.boolean().optional(),
      }),
      output: commandDefs['rows.update'].output,
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ paused, ...rest }) => {
      const hasFields = Object.keys(rest).some((k) => k !== 'collection' && k !== 'row' && (rest as Record<string, unknown>)[k] !== undefined);
      let out = hasFields ? await run('rows.update', rest) : undefined;
      if (paused !== undefined) {
        const r = await run(paused ? 'rows.pause' : 'rows.resume', { collection: rest.collection, rows: [rest.row] });
        out = { row: r.rows[0]!, cursor: r.cursor };
      }
      if (!out) throw new ServiceError('validation', 'nothing to update');
      return ok(out);
    },
  );

  tool(
    'remove_rows',
    {
      title: 'Remove rows',
      description: 'Remove rows and their generations (assets are kept).',
      input: z.object({ collection: collectionArg, rows: z.array(rowIdSchema).min(1) }),
      output: commandDefs['rows.remove'].output,
      annotations: DESTRUCTIVE,
    },
    async (input) => ok(await run('rows.remove', input)),
  );

  // -- cells / generations ---------------------------------------------------------------------

  const cellOutput = z.object({
    cell: cellViewSchema,
    current: generationSchema.optional(),
    versions: z.array(commandDefs['cells.get'].output.shape.versions.element),
    ...cursorOut,
  });

  tool(
    'get_cell',
    {
      title: 'Get cell',
      description: 'One cell: current generation (request snapshot, error, timing), its version history, and by default the current output image(s).',
      input: z.object({
        cell: cellArg,
        images: z.boolean().optional().describe('Inline the current outputs. Default true.'),
        size: sizeArg,
      }),
      output: cellOutput,
      annotations: READ,
    },
    async ({ cell, images, size }) => {
      const out = await run('cells.get', { cell });
      const blocks: ContentBlock[] = [];
      if (images !== false) for (const a of out.cell.outputs) blocks.push(...(await imageBlocks(a, out.cell.address, size ?? 'small')));
      else blocks.push(...linkBlocks(out.cell.outputs, out.cell.address));
      return ok(out, blocks);
    },
  );

  tool(
    'get_generation',
    {
      title: 'Get generation',
      description: 'A generation by id or collection/row/column#version: full request snapshot, status, error, timing, provider metadata, and its outputs as images.',
      input: z.object({
        generation: z.string().describe('6-character id or collection/row/column#version'),
        images: z.boolean().optional().describe('Inline outputs. Default true.'),
        size: sizeArg,
      }),
      output: commandDefs['generations.get'].output,
      annotations: READ,
    },
    async ({ generation, images, size }) => {
      const out = await run('generations.get', { generation });
      const g: Generation = out.generation;
      const label = `${g.collection}/${g.row}/${g.column}#${g.version}`;
      const blocks: ContentBlock[] = [];
      if (images !== false) for (const a of g.outputs) blocks.push(...(await imageBlocks(a, label, size ?? 'small')));
      else blocks.push(...linkBlocks(g.outputs, label));
      return ok(out, blocks);
    },
  );

  tool(
    'view_images',
    {
      title: 'View images',
      description: `Look at images. refs are cell addresses (current outputs), generation refs (collection/row/column#version or id), or asset ids; each image is preceded by a label. At most ${MAX_IMAGES_PER_RESULT} images per call.`,
      input: z.object({
        refs: z.array(z.string()).min(1).max(MAX_IMAGES_PER_RESULT),
        size: sizeArg,
      }),
      output: z.object({
        images: z.array(z.object({ ref: z.string(), label: z.string(), assets: z.array(z.string()) })),
        omitted: z.number().int(),
      }),
      annotations: READ,
    },
    async ({ refs, size }) => {
      const blocks: ContentBlock[] = [];
      const images: { ref: string; label: string; assets: string[] }[] = [];
      let shown = 0;
      let omitted = 0;
      for (const ref of refs) {
        const resolved = resolveRef(ref);
        images.push({ ref, ...resolved });
        if (resolved.assets.length === 0) {
          blocks.push(text(`${resolved.label}: no output yet`));
          continue;
        }
        for (const a of resolved.assets) {
          if (shown >= MAX_IMAGES_PER_RESULT) {
            omitted++;
            continue;
          }
          blocks.push(...(await imageBlocks(a, resolved.label, size ?? 'small')));
          shown++;
        }
      }
      if (omitted > 0) blocks.push(text(`${omitted} image(s) omitted (limit ${MAX_IMAGES_PER_RESULT} per call).`));
      const structured = { images, omitted };
      return ok(structured, blocks, `${shown} image(s)${omitted ? `, ${omitted} omitted` : ''}: ${images.map((i) => `${i.label} → ${i.assets.join(', ') || '(none)'}`).join('; ')}`);
    },
  );

  tool(
    'regenerate_cell',
    {
      title: 'Regenerate cell',
      description: '"Give me another one": queue a fresh sample of the same request. The previous result stays in the version history.',
      input: z.object({ cell: cellArg }),
      output: commandDefs['cells.regenerate'].output,
      annotations: WRITE,
    },
    async (input) => ok(await run('cells.regenerate', input)),
  );

  tool(
    'retry_cell',
    {
      title: 'Retry cell',
      description: 'Retry a failed, unsupported, or needs_attention cell with a fresh generation. Failed cells never retry on their own.',
      input: z.object({ cell: cellArg }),
      output: commandDefs['cells.retry'].output,
      annotations: WRITE,
    },
    async (input) => ok(await run('cells.retry', input)),
  );

  tool(
    'cancel_cell',
    {
      title: 'Cancel cell',
      description: 'Cancel the in-flight generation of a cell, if any.',
      input: z.object({ cell: cellArg }),
      output: commandDefs['cells.cancel'].output,
      annotations: IDEMPOTENT_WRITE,
    },
    async (input) => ok(await run('cells.cancel', input)),
  );

  // -- assets ---------------------------------------------------------------------------------------

  tool(
    'upload_asset',
    {
      title: 'Upload asset',
      description: 'Add an image to use as a row input (reference, init, or mask): base64 bytes, a local file path readable by the server, or a URL. Returns the asset id.',
      input: commandDefs['assets.upload'].input,
      output: commandDefs['assets.upload'].output,
      annotations: WRITE,
    },
    async (input) => {
      const out = await run('assets.upload', input);
      const row = services.assets.getRow(out.asset.id);
      return ok(out, row ? [assetLink(row)] : []);
    },
  );

  tool(
    'list_assets',
    {
      title: 'List assets',
      description: 'List assets (uploads and generated outputs), newest first, with dimensions, labels, and origin.',
      input: commandDefs['assets.list'].input,
      output: commandDefs['assets.list'].output,
      annotations: READ,
    },
    async (input) => ok(await run('assets.list', input)),
  );

  tool(
    'get_asset',
    {
      title: 'Get asset',
      description: 'Asset metadata plus the image itself.',
      input: z.object({ asset: z.string().describe('Asset id'), images: z.boolean().optional().describe('Default true'), size: sizeArg }),
      output: z.object({ asset: assetViewSchema }),
      annotations: READ,
    },
    async ({ asset, images, size }) => {
      const out = await run('assets.get', { asset });
      const blocks = images !== false ? await imageBlocks(asset, out.asset.label ?? asset, size ?? 'small') : linkBlocks([asset], asset);
      return ok(out, blocks);
    },
  );

  // -- resources ---------------------------------------------------------------------------------------

  const json = (uri: string, value: unknown): ReadResourceResult => ({
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 1) }],
  });

  server.registerResource(
    'models',
    URI.models,
    { title: 'Models', description: 'Available models with capabilities and settings schemas.', mimeType: 'application/json' },
    async (uri) => json(uri.href, await run('models.list', {})),
  );

  server.registerResource(
    'collections',
    URI.collections,
    { title: 'Collections', description: 'Every collection with status and cell counts.', mimeType: 'application/json' },
    async (uri) => json(uri.href, await run('collections.list', {})),
  );

  server.registerResource(
    'collection',
    new ResourceTemplate('imaginator://collections/{slug}', {
      list: async () => ({
        resources: services.collections.list().map((c) => ({
          uri: URI.collection(c.slug),
          name: c.slug,
          title: c.title,
          description: `${c.status} · ${c.rows} rows × ${c.columns} columns · ${c.succeeded}/${c.cells} succeeded`,
          mimeType: 'application/json',
        })),
      }),
      complete: {
        slug: async (value) => services.collections.list().map((c) => c.slug).filter((s) => s.startsWith(value)),
      },
    }),
    { title: 'Collection', description: 'One collection: rows, columns, defaults, and every cell with status and outputs.', mimeType: 'application/json' },
    async (uri, vars) => json(uri.href, await run('collections.get', { collection: String(vars.slug) })),
  );

  const readAssetBlob = async (uri: URL, id: string, size: 'medium' | 'full'): Promise<ReadResourceResult> => {
    const row = services.assets.getRow(id);
    if (!row) throw new ServiceError('not_found', `asset ${id} not found`);
    if (row.kind !== 'image') {
      const bytes = await store.readOriginal(row.id, row.ext);
      return { contents: [{ uri: uri.href, mimeType: row.mime, blob: Buffer.from(bytes).toString('base64') }] };
    }
    if (size === 'medium') {
      const img = await imageForModel(store, row, 'medium');
      return { contents: [{ uri: uri.href, mimeType: img!.mimeType, blob: img!.data }] };
    }
    const bytes = await store.readOriginal(row.id, row.ext);
    return { contents: [{ uri: uri.href, mimeType: row.mime, blob: Buffer.from(bytes).toString('base64') }] };
  };

  server.registerResource(
    'asset',
    new ResourceTemplate('imaginator://assets/{id}', {
      list: async () => ({
        resources: services.assets.list({ limit: 50 }).assets.map((a) => ({
          uri: URI.asset(a.id),
          name: a.id,
          ...(a.label ? { title: a.label } : {}),
          description: `${a.origin.type === 'upload' ? 'upload' : `output of ${a.origin.generation}`} · ${a.width}×${a.height}`,
          mimeType: a.mime,
          size: a.bytes,
        })),
      }),
    }),
    { title: 'Asset', description: 'Original bytes of an asset (uploaded or generated image).' },
    (uri, vars) => readAssetBlob(uri, String(vars.id), 'full'),
  );

  server.registerResource(
    'asset-thumbnail',
    new ResourceTemplate('imaginator://assets/{id}/thumb', { list: undefined }),
    { title: 'Asset thumbnail', description: '≤800px webp thumbnail of an asset.', mimeType: 'image/webp' },
    (uri, vars) => readAssetBlob(uri, String(vars.id), 'medium'),
  );

  // -- resource subscriptions (2025-era sessions): collection resources follow the event bus ----------

  if (options.legacySubscriptions) {
    const subscriptions = new Set<string>();
    server.server.setRequestHandler('resources/subscribe', async ({ params }) => {
      subscriptions.add(params.uri);
      return {};
    });
    server.server.setRequestHandler('resources/unsubscribe', async ({ params }) => {
      subscriptions.delete(params.uri);
      return {};
    });

    const pendingUpdates = new Map<string, NodeJS.Timeout>();
    const notifyUpdated = (uri: string) => {
      if (!subscriptions.has(uri) || pendingUpdates.has(uri)) return;
      pendingUpdates.set(
        uri,
        setTimeout(() => {
          pendingUpdates.delete(uri);
          void server.server.sendResourceUpdated({ uri }).catch(() => {});
        }, 250),
      );
    };
    const onEvent = (e: ImaginatorEvent) => {
      if (!server.isConnected()) return;
      if ('collection' in e) {
        notifyUpdated(URI.collection(e.collection));
        notifyUpdated(URI.collections);
        if (e.type === 'collection.created' || e.type === 'collection.deleted') server.sendResourceListChanged();
      } else if (e.type === 'asset.created') {
        server.sendResourceListChanged();
      }
    };
    const unsubscribe = bus.on(onEvent);
    const previousClose = server.server.onclose;
    server.server.onclose = () => {
      unsubscribe();
      for (const t of pendingUpdates.values()) clearTimeout(t);
      pendingUpdates.clear();
      previousClose?.();
    };
  }

  // -- prompts ---------------------------------------------------------------------------------------------------

  server.registerPrompt(
    'compare-models',
    {
      title: 'Compare models',
      description: 'Set up a collection that runs the same prompts across several models and review the results.',
      argsSchema: z.object({
        prompts: z.string().describe('One prompt per line'),
        models: completable(z.string().describe('Comma-separated model ids; omit to pick from list_models'), (value) =>
          services.ctx.registry
            .list()
            .map((m) => m.id)
            .filter((id) => id.startsWith(value.split(',').pop()?.trim() ?? '')),
        ).optional(),
      }),
    },
    ({ prompts, models }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Use the imaginator tools to compare image models.',
              models ? `Models: ${models}.` : 'First call list_models and pick 2-4 image models that make sense for these prompts.',
              'Prompts (one row each):',
              prompts,
              '',
              'Create a live collection with one column per model and one row per prompt, then loop wait_for_collection until nothing is queued or in flight. Then view_images for every cell and write a short comparison: which model handled each prompt best and why, noting failures or unsupported cells. Finish with the collection slug so I can open it in the UI.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}
