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
