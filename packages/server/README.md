# @imaginator/server

SQLite (better-sqlite3 + drizzle) metadata, filesystem assets, a declarative
reconciler + in-process runner over the `generations` table, provider adapters
(`mock` ships; real providers register in `src/providers/index.ts`), and a Hono
HTTP + SSE transport generated from the command registry in `@imaginator/core`.
Read `docs/DESIGN.md` at the repo root first.

## Run

```sh
cp .env.example .env            # at the repo root; IMAGINATOR_MOCK=1 enables the mock provider
pnpm --filter @imaginator/server dev      # tsx watch, http://127.0.0.1:4747
pnpm --filter @imaginator/server test     # vitest, temp data dir per test
pnpm --filter @imaginator/server typecheck
```

Config comes from env (`.env` at the repo root is loaded by `main.ts`):
`IMAGINATOR_DATA_DIR` (default `./data`, relative to the repo root),
`IMAGINATOR_PORT` (4747), `IMAGINATOR_GLOBAL_CONCURRENCY` (8),
`IMAGINATOR_<PROVIDER>_CONCURRENCY`, and one API key per provider
(`OPENAI_API_KEY`, ...). The mock provider is on when `IMAGINATOR_MOCK=1` or
when no real key is present. `createApp(overrides)` in `src/app.ts` boots the
same thing programmatically (tests use it with a temp data dir).

## Browsing the API

`GET /api` (e.g. http://localhost:4747/api) returns every command with its
description and JSON Schemas for input and output. The source of truth is
`packages/core/src/commands.ts`; the walkthrough below shows the common calls.

## Layout

| Path | What |
|---|---|
| `src/config.ts` | env → `ServerConfig`, tiny `.env` parser |
| `src/db/` | drizzle schema + SQL migrations run at boot (WAL, foreign keys, cascade) |
| `src/assets/store.ts` | stage → sniff/hash/measure → atomic rename into `data/assets/<shard>/`, lazy webp thumbs, tmp sweep |
| `src/events/bus.ts` | typed in-process bus, per-collection cursors (`<bootId>.<seq>`), `waitForCursor` |
| `src/services/` | every DB write: one transaction, events after commit; `collections.get` builds the `CollectionView` |
| `src/engine/reconciler.ts` | debounced per-collection passes; superseded work cancelled (queued at once, submitted only when the provider confirms) |
| `src/engine/runner.ts` | pick loop with global/provider/model semaphores, `execute()` lifecycle, boot recovery table from DESIGN §4.2 |
| `src/providers/mock.ts` | controllable mock provider (`mockControl.hold/release/failNext/cancelOutcome`) |
| `src/providers/http.ts` | `fetchJson`/`fetchBytes` with timeout and opt-in retry (safe-to-repeat calls only) |
| `src/commands/registry.ts` | attaches `run()` to every core `CommandDef` |
| `src/http/app.ts` | `POST /api/<command>`, `GET /api/<read command>`, `/api/events` SSE, `/assets/:id[/thumb]`, static `packages/web/dist` |

Every write goes through a service function; nothing else touches the DB.
The reconciler and runner only ever observe the bus and the `generations` table.

## curl walkthrough

```sh
IMAGINATOR_MOCK=1 pnpm --filter @imaginator/server start &
B=http://127.0.0.1:4747; J='content-type: application/json'

# Models with capabilities and settings schema
curl -s $B/api/models.list | jq '.models[].id'

# A live collection: two mock columns x three rows. Nothing is imperative; the
# reconciler fills rows x columns and the runner executes them.
curl -s -X POST $B/api/collections.create -H "$J" -d '{
  "slug": "neon-cats", "title": "Neon cats",
  "columns": [{ "model": "mock/fast" }, { "model": "mock/slow", "settings": { "delayMs": 400 } }],
  "rows": [{ "prompt": "a neon cat on a rooftop" }, { "prompt": "a cyberpunk kitten" },
           { "prompt": "two cats in a tokyo alley", "settings": { "seed": 7 } }]
}' | jq '{cursor, cells: [.cells[] | {address, status}]}'

# Agent loop: mutate (get cursor) -> wait(cursor) -> get, while inFlight or queued > 0.
CUR=$(curl -s "$B/api/collections.get?collection=neon-cats" | jq -r .cursor)
while :; do
  R=$(curl -s -X POST $B/api/collections.wait -H "$J" -d "{\"collection\":\"neon-cats\",\"cursor\":\"$CUR\",\"timeoutMs\":5000}")
  echo "$R"; CUR=$(echo "$R" | jq -r .cursor)
  [ "$(echo "$R" | jq '.inFlight + .queued')" = 0 ] && break
done

# The grid: every cell with status, asset ids, urls and thumbnails
curl -s "$B/api/collections.get?collection=neon-cats" | jq '.cells[] | {address, status, urls, thumbnails}'

# Images (long-lived cache headers; a missing original is a 500 storage error, not a blank)
ID=$(curl -s "$B/api/collections.get?collection=neon-cats" | jq -r '.cells[0].outputs[0]')
curl -sI $B/assets/$ID | grep -i content-type          # image/png
curl -sI $B/assets/$ID/thumb | grep -i content-type    # image/webp, max 800px

# Edit a row: only that row's cells get new generations. Revert it: the old
# generation with the same hash becomes current again with no new run.
curl -s -X POST $B/api/rows.update -H "$J" -d '{"collection":"neon-cats","row":"r1","prompt":"a neon cat at dawn"}' | jq .cursor
curl -s -X POST $B/api/rows.update -H "$J" -d '{"collection":"neon-cats","row":"r1","prompt":"a neon cat on a rooftop"}' | jq .cursor

# Cell detail with version history; "give me another one"; retry a failed cell
curl -s "$B/api/cells.get?cell=neon-cats/r1/fast" | jq '{status: .cell.status, versions: [.versions[] | {version, status}]}'
curl -s -X POST $B/api/cells.regenerate -H "$J" -d '{"cell":"neon-cats/r1/fast"}' | jq .generation.version
curl -s "$B/api/generations.get?generation=neon-cats/r1/fast%232" | jq .generation.request

# Uploads (JSON base64 / path / url, or multipart) become row inputs
curl -s -X POST $B/api/assets.upload -F file=@photo.png -F label=reference-dog | jq .asset.id
curl -s -X POST $B/api/assets.upload -H "$J" -d '{"path":"/abs/path/photo.png"}' | jq .asset.id

# Pause, edit freely, resume -> one reconcile pass, one wave of jobs
curl -s -X POST $B/api/collections.pause  -H "$J" -d '{"collection":"neon-cats"}' | jq .status
curl -s -X POST $B/api/collections.resume -H "$J" -d '{"collection":"neon-cats"}' | jq .status

# Live events (hello with bootId, then every event; filter by collection)
curl -N "$B/api/events?collection=neon-cats"

# Housekeeping
curl -s -X POST $B/api/assets.gc -H "$J" -d '{"dryRun":true}'
curl -s -X POST $B/api/collections.export -H "$J" -d '{"collection":"neon-cats"}' > neon-cats.json
```

Errors are `{ "error": { "message", "code", "issues"? } }` with 400
(validation), 404 (not found), 409 (conflict), 500 (storage/internal).

## MCP

The same process serves MCP over **Streamable HTTP** at `POST|GET|DELETE /mcp`
using the official TypeScript SDK v2 (`@modelcontextprotocol/server`). Two
protocol eras share the endpoint, routed by the SDK's own `isLegacyRequest`:

- **2026-07-28** (envelope in `_meta`, no handshake, `subscriptions/listen`):
  the SDK's `createMcpHandler` in `legacy: 'reject'` mode, stateless per
  request, with the event bus published onto the handler's subscription bus.
- **2025-era** (`initialize` + `Mcp-Session-Id`, which is what Claude Code,
  Claude Desktop, ChatGPT, Cursor, VS Code, OpenClaw and Hermes speak today):
  a stateful session per `initialize`, one `McpServer` each, so the standalone
  GET stream can carry `notifications/resources/updated`. Idle sessions are
  swept after two hours.

Code lives in `src/mcp/`: `server.ts` (tools, resources, prompt), `http.ts`
(era routing + sessions), `images.ts` (rendering assets for a model),
`stdio.ts` (bridge).

Connect a client:

```sh
# Claude Code (streamable HTTP)
claude mcp add --transport http imaginator http://127.0.0.1:4747/mcp
# Anything that only launches local stdio servers: the bridge forwards JSON-RPC
# to the running server, so the engine still runs in exactly one process.
claude mcp add imaginator -- pnpm --dir /path/to/imaginator mcp
```

```json
{ "mcpServers": { "imaginator": { "command": "pnpm", "args": ["--dir", "/path/to/imaginator", "mcp"] } } }
```

The bridge (`pnpm mcp`) reads `IMAGINATOR_SERVER_URL` (default
`http://127.0.0.1:$IMAGINATOR_PORT`) and exits with a message if no server is
listening there.

**Tools** are the agent surface and deliberately not one-per-command. UI-only
operations (reorder, rename, duplicate, import/export, labels, gc) stay
HTTP-only; some pairs are folded (`update_collection` takes `status`,
`update_row` takes `paused`, `add_columns` is bulk).

| Tool | Notes |
|---|---|
| `list_models`, `list_collections`, `get_collection`, `wait_for_collection` | `get_collection images=true` inlines small images (max 8). `wait_for_collection` sends `notifications/progress` when the client passes a progress token. |
| `create_collection`, `update_collection`, `delete_collection` | `create_collection` takes columns and rows inline: one call sets up a comparison. |
| `add_columns`, `update_column`, `remove_column`, `add_rows`, `update_row`, `remove_rows` | Mutations return the collection cursor. |
| `get_cell`, `get_generation`, `view_images` | Return `image` content blocks, each preceded by a text label naming the cell/generation/asset. `view_images` accepts cell addresses, generation refs, and asset ids. |
| `regenerate_cell`, `retry_cell`, `cancel_cell` | The only imperative operations. |
| `upload_asset`, `list_assets`, `get_asset` | Upload from base64, a server-readable path, or a URL. |

Every tool has an `outputSchema` and returns `structuredContent` plus the same
JSON as a text block (the spec's recommendation, and the only thing ChatGPT
shows the model). Errors from the command layer come back as `isError` results
with the code (`validation: ...`, `not_found: ...`) so the model can correct
itself; schema violations are rejected by the SDK before the handler as
JSON-RPC `-32602`. Tool annotations (`readOnlyHint`, `destructiveHint`, ...)
are set on every tool.

**Images: what clients actually do.** Inline `image` blocks in tool results
are the one path that reaches the model in Claude (Desktop, web, Code),
Cursor, VS Code, Codex CLI, Gemini CLI, Zed and Cline. ChatGPT connectors drop
image blocks (only text and `structuredContent` reach the model). Resources
are user-attached in every client (`@` mentions, "Add Context"); no client
feeds them to the model on its own, and only VS Code implements
`resources/subscribe`. `resource_link` blocks are documented only for Gemini
CLI. So the tools carry the workflow, every image comes with a text label, and
resources mirror the read side for people who want to attach them.

Sizes matter more than the protocol: Claude Code counts image base64 as text
against `MAX_MCP_OUTPUT_TOKENS` (default 25k) and Claude Desktop caps a result
at ~150k characters. Measured on a noisy 1024px image:

| size | encoding | bytes | base64 chars |
|---|---|---|---|
| `small` (default) | <=512px webp q72 | ~35 KB | ~47k |
| `medium` | <=800px webp q85 (the UI thumbnail) | ~200 KB | ~270k |
| `full` | original, re-encoded above 1568px / 3 MB | up to 3 MB | |

Real generated images compress two to four times better than that. `small` is
enough to judge composition; ask for `medium` or `full` on one cell when detail
matters. At most 8 images per result. When images are turned off, outputs are
listed as `resource_link` blocks (`imaginator://assets/<id>`) whose description
carries the plain HTTP URL.

**Resources** mirror the read side: `imaginator://models`,
`imaginator://collections` (JSON lists), `imaginator://collections/{slug}` (the
grid, with completion on `slug`, listed one per collection, subscribable on
both eras: the event bus is forwarded, debounced 250 ms),
`imaginator://assets/{id}` (original bytes as a blob, latest 50 listed) and
`imaginator://assets/{id}/thumb` (<=800px webp).

**Prompt** `compare-models` (`prompts`, one per line; optional `models` with
completion) is a slash-command style workflow: create the grid, wait, look at
every cell, write a comparison.

**Not implemented on purpose.** The 2025-11-25 tasks feature and the
2026-07-28 tasks extension (no client supports them; `wait_for_collection`
long-polls instead), elicitation and sampling (nothing here needs them), and
auth (localhost tool; put it behind a tunnel with its own auth if you must).

## Mock provider

`mock/fast`, `mock/slow` (resumable job handle, honors `size`), `mock/flaky`
(random retryable/ambiguous failures unless `mockControl.deterministic`),
`mock/img2img` (init + mask + reference), `mock/text-only` (count 1). In tests
`mockControl` can hold calls at a phase (`start`, `running`, `complete`),
release them in any order, fail the next call with a chosen kind, and choose the
`cancel()` outcome, which is how the DESIGN §10 cases are exercised.

## Adding a provider

Implement `Provider` from `@imaginator/core` (`generate`, optional `resume` and
`cancel`, `models: ModelSpec[]`), use `src/providers/http.ts` for polls,
downloads and uploads (never retry a plain submission POST), throw
`ProviderError` with `kind: 'ambiguous'` when a submission may have been
accepted, and register it in `buildProviders()` in `src/providers/index.ts`.
