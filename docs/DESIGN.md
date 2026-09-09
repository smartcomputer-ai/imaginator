# Imaginator — Core Design

A personal workbench for comparing image (later video) generation models. A
**collection** is a grid: rows are prompts plus inputs and settings, columns are
models. The backend keeps every live collection "filled in" by generating
whatever cells are missing or stale. A UI and an MCP server are two clients of
the same core API.

This document covers the stack, the domain model, the generation engine, and
the shape of the API. It deliberately does not spell out HTTP routes or MCP tool
signatures; those are derived from the command layer described in §6.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript everywhere** (Node 22 LTS, pnpm workspaces) | One language for server, UI, and MCP. Domain types and zod schemas are shared, not duplicated. Node is async by construction, so there is no sync/async split to police, unlike Python where one blocking SDK call stalls the loop. The MCP TypeScript SDK is the reference implementation. Most provider APIs are plain REST plus polling, which is a few lines of `fetch` each. |
| HTTP | **Hono** with zod validation | Tiny, typed, runs on Node or Bun unchanged. Same zod schemas validate HTTP bodies and MCP tool inputs. |
| Realtime | **Server-Sent Events** | We only need server → client push; mutations go over HTTP. SSE reconnects for free and needs no extra library. |
| Persistence | **SQLite** (better-sqlite3 + Drizzle) for metadata, **filesystem** for blobs | Single file, transactional, zero ops, survives restarts, queryable. Blobs never go in the DB. |
| Images | **sharp** | Thumbnails, format normalization, dimensions at ingest. |
| Jobs | **In-process async runner** over the `generations` table | No Redis, no queue library. The DB row *is* the job record; durability comes from re-reading it on boot. See §4. |
| UI | **Vite + React + Tailwind + shadcn/ui**, TanStack Query for data, SSE patched into the query cache | Solid components fast, no design work needed. |
| MCP | `@modelcontextprotocol/sdk`, stdio and streamable-HTTP | Tools generated from the command registry (§6). |

**Why not Python.** Python would work, and Pillow is nicer than sharp. But it
costs a second language, duplicated types, and constant vigilance that no SDK
does blocking I/O inside the event loop. The provider SDKs are not an argument
either way; we are writing thin adapters over REST regardless.

**Why not pure filesystem persistence.** Attractive for git-ability, but the
reconciler (§4) needs cheap queries like "latest generation per cell", "all
queued jobs for provider X", and atomic multi-row updates. SQLite gives that
with no server. We keep portability by adding `collection export/import` as
JSON commands; a collection is fully described by one JSON document plus the
assets it references.

**Layout**

```
imaginator/
  packages/
    core/     # domain types, zod schemas, id generation, request resolution
              # and hashing, Provider interface. No I/O. Shared by all.
    server/   # sqlite schema + repos, services, reconciler, runner,
              # provider adapters, HTTP + SSE, MCP server, asset store
    web/      # Vite React app
  data/       # runtime data, gitignored
    imaginator.db
    assets/k3/k3q2m7.png
    assets/k3/k3q2m7.thumb.webp
```

---

## 2. Identifiers

All IDs are short, lowercase, and meant to be typed by humans and LLMs.

| Thing | ID | Example | Notes |
|---|---|---|---|
| Collection | user- or agent-chosen slug | `neon-cats` | Unique globally. Rename allowed via a `rename` command that rewrites references. |
| Column | slug, unique within collection | `flux-pro`, `gpt-image`, `flux-pro-hq` | Defaults to the model's short name. Two columns may point at the same model with different settings. |
| Row | `r` + per-collection counter, never reused | `r1`, `r7` | Stable across reordering. Gaps after deletes are fine. |
| Cell | path `collection/row/column` | `neon-cats/r3/flux-pro` | Not stored; derived address for a (row, column) pair. |
| Generation | random 6 chars | `q7m2kd` | One attempt to fill a cell. Also addressable as `neon-cats/r3/flux-pro#2` (2nd version of that cell). |
| Asset | random 6 chars, also the filename stem | `k3q2m7` → `k3q2m7.png` | Uploaded or generated. Global; reusable across collections. |
| Model | `provider/model` | `openai/gpt-image-1`, `bfl/flux-pro-1.1`, `fal/recraft-v3` | Static registry in code. |

Random IDs use the alphabet `23456789abcdefghjkmnpqrstuvwxyz` (no `0/o/1/l/i`).
Six characters gives ~887M values; the insert checks for collisions anyway.
No prefixes: the context (an `inputs` array, an `assets` list) says what it is,
and the API accepts the readable path forms everywhere an ID is expected.

---

## 3. Domain model

```
Collection ─┬─ columns[]  (Column: id, model, settings overrides, position)
            ├─ rows[]     (Row: id, prompt, inputs[], settings, paused, position)
            └─ defaults   (settings applied to every row unless overridden)

Cell (row × column) ── generations[]  (history, newest = current)
                             └─ outputs[] → Asset

Asset  (uploaded | generated) ── file on disk + thumbnail + dimensions + mime
```

### Collection
```ts
{
  slug: 'neon-cats',
  title: 'Neon cats',
  description?: string,
  status: 'live' | 'paused',        // paused = edit freely, nothing generates
  defaults: Settings,                // aspect ratio, count, seed, ...
  columns: Column[],
  rows: Row[],
  createdAt, updatedAt
}
```

### Column
```ts
{ id: 'flux-pro', model: 'bfl/flux-pro-1.1', settings?: Settings, position: number }
```

### Row
```ts
{
  id: 'r3',
  prompt: string,
  negativePrompt?: string,
  inputs: AssetId[],                 // reference images, in order
  settings?: Settings,               // overrides collection defaults
  paused: boolean,
  position: number,
  notes?: string                     // free text, not part of the request
}
```

### Settings
A flat bag with a small **common** vocabulary every provider understands
(`aspectRatio`, `size`, `count`, `seed`, `outputFormat`) plus a `model` namespace
for provider-specific knobs (`quality`, `style`, `guidance`, `steps`, ...).
Each model declares which common keys it honors and a zod schema for its own
keys. Unsupported keys are dropped at resolution time and the drop is recorded
on the generation so the UI can show "seed ignored by this model".

Resolution order: `collection.defaults` ← `column.settings` ← `row.settings`.

### Generation
```ts
{
  id: 'q7m2kd',
  collection: 'neon-cats', row: 'r3', column: 'flux-pro',
  version: 2,                        // ordinal within the cell
  requestHash: 'sha256…',            // hash of `request` below
  request: ResolvedRequest,          // full snapshot; reproducible later
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled',
  providerRef?: string,              // remote job handle, for resume after restart
  outputs: AssetId[],
  error?: { message, code?, retryable },
  attempt: number,
  forced: boolean,                   // true = user asked for "another one"
  timing: { queuedAt, startedAt?, finishedAt? },
  cost?: number,
  providerMeta?: unknown             // raw response bits worth keeping
}
```

`ResolvedRequest` is what the provider actually receives: model, prompt,
negative prompt, input asset IDs, resolved settings. It is fully materialized,
so a generation is reproducible and comparable without looking at the row it
came from. Rows can change; generations never do.

### Asset
```ts
{
  id: 'k3q2m7',
  kind: 'image' | 'video',
  origin: { type: 'upload' } | { type: 'generation', generation: 'q7m2kd' },
  mime, width, height, bytes, sha256,
  label?: string,                    // human/agent-given name, e.g. "reference-dog"
  createdAt
}
```

Assets are never deleted by row or collection deletion; they may be inputs
elsewhere. A `assets gc` command removes assets referenced by nothing, on
request only.

---

## 4. The generation engine

The engine is **declarative**. Nothing in the API says "generate this". The
API only edits collections; the engine keeps live collections filled in.

### 4.1 Desired state and reconciliation

For every live collection, every non-paused row, and every column, the desired
generation is identified by `requestHash = hash(resolve(collection, row, column))`.

A cell is **satisfied** when it has a generation with that hash in status
`queued`, `running`, or `succeeded`. Otherwise the reconciler inserts a new
`queued` generation with that hash and a snapshot of the request.

The reconciler runs:
- after any mutation to a collection, its rows, or its columns (debounced ~200ms per collection),
- when a collection is resumed or a row unpaused,
- on server boot,
- never on a timer; there is nothing to discover that an event did not announce.

Consequences that fall out for free:
- Edit a row → only that row's cells get new generations. Other rows are untouched.
- Add a column → every row gets one new cell.
- Revert an edit → the old hash already has a succeeded generation, so nothing
  runs and that generation becomes current again. Version history is real history.
- Pause, edit ten things, resume → one reconcile pass, one wave of jobs.
- Restart → reconcile picks up where it left off.
- Provider changes (API keys, concurrency, even model default settings in the
  registry) are *not* part of the hash, so they never trigger regeneration.
  Only the collection's own content does.

**Failed generations do not self-heal.** A failed generation counts as
satisfying the cell until someone retries it; otherwise a broken prompt would
burn money forever. Transient errors (429, 5xx, network) retry with backoff up
to a small cap *inside* the runner before being marked failed.

**Superseded work is cancelled.** When a row edit changes a cell's hash while
a generation for the old hash is queued or running, the reconciler marks it
`cancelled` (aborting the in-flight call via `AbortSignal`, and calling the
provider's cancel endpoint if it has one). If the provider already finished,
the output is still stored; it just is not current.

**"Give me another one"** is the one imperative: `cell regenerate` inserts a
new generation with the same hash and `forced: true`. Useful for
non-deterministic models. The current version of a cell is the newest
non-cancelled generation whose hash matches the desired hash.

### 4.2 The runner

A single in-process loop, one per server:

```
loop:
  pick queued generations, oldest first, where
    provider slots available (per-provider semaphore) and
    global slots available (global semaphore)
  for each: mark running, spawn `execute(generation)` (not awaited)
  await "something changed" (new queued row, slot released), then loop
```

`execute` resolves input assets to bytes, calls the provider adapter, stores
outputs as assets, updates the generation, and emits events. It never blocks
the loop; every provider wait is an `await` on `fetch` or `setTimeout`. With a
few dozen in-flight generations the process is idle almost all the time, since
the real work happens at the provider.

Concurrency limits live in config: a global cap and a per-provider cap
(OpenAI might allow 5, a small provider 2). The `models` registry can give a
per-model default.

**Durability.** The `generations` table is the queue. On boot:
- `queued` rows are simply picked up.
- `running` rows with a `providerRef` are handed to the adapter's `resume()`
  if it implements one; otherwise they are marked `failed` with a
  `retryable: true` error and the reconciler requeues them.

This is "durable enough" for a single-user tool without a separate queue
service. If we ever need multiple processes, the loop becomes
`UPDATE … WHERE status='queued' … RETURNING` with a lease column; the rest is unchanged.

### 4.3 Provider adapters

Each provider is a module implementing one small interface. No abstraction
library; we own it.

```ts
interface Provider {
  id: string;                          // 'openai', 'bfl', 'fal', 'google', 'replicate', 'mock'
  models: ModelSpec[];
  generate(req: ResolvedRequest, ctx: GenerateContext): Promise<GenerateResult>;
  resume?(providerRef: string, ctx: GenerateContext): Promise<GenerateResult>;
  cancel?(providerRef: string): Promise<void>;
}

interface ModelSpec {
  id: string;                          // 'bfl/flux-pro-1.1'
  name: string;
  kind: 'image' | 'video';
  capabilities: {
    inputImages: number;               // 0 = text-only
    negativePrompt: boolean;
    seed: boolean;
    count: number;                     // max per request
    aspectRatios?: string[];           // or sizes
    sizes?: string[];
  };
  settings: ZodObject;                 // model-specific keys, drives UI forms + validation
  concurrency?: number;
}

interface GenerateContext {
  signal: AbortSignal;
  asset(id: AssetId): Promise<{ bytes: Buffer; mime: string; path: string }>;
  setProviderRef(ref: string): Promise<void>;   // persist remote job handle ASAP
  sleep(ms: number): Promise<void>;             // abortable
  log(msg: string): void;
}

interface GenerateResult {
  outputs: Array<{ bytes: Buffer; mime: string; meta?: unknown }>;
  cost?: number;
  providerMeta?: unknown;
}
```

Adapters that poll do so with `ctx.sleep` and honor `signal`. A shared
`http.ts` helper gives retry-with-backoff on 429/5xx and timeout handling so
adapters stay short. Aggregators (fal, Replicate) are one adapter each with
many models in their registry; that is how we get Recraft, Ideogram, and
friends cheaply.

A **`mock` provider** ships from day one: it renders the prompt onto a colored
image with sharp after a random delay and occasionally fails on purpose. The
whole UI and engine can be developed and tested without spending a cent.

### 4.4 Assets

Ingest (`upload` or generation output): sniff mime, compute sha256, read
dimensions, write `data/assets/<2-char shard>/<id>.<ext>`, write a webp
thumbnail alongside, insert the row. Served at `/assets/:id` and
`/assets/:id/thumb` with long cache headers, since content never changes.

Dedup by sha256 is optional; an upload of an already-present file can return
the existing ID.

---

## 5. Reactivity

One in-process typed **event bus**. Every write goes through a service
function that (1) runs one SQLite transaction, (2) emits events after commit.
Nothing writes to the DB outside services. Events:

```
collection.created | .updated | .deleted        { slug }
row.updated | row.deleted                       { collection, row }
column.updated | column.deleted                 { collection, column }
generation.updated                              { id, collection, row, column, status }
asset.created                                   { id }
```

Events carry IDs, not payloads. Consumers refetch what they need; that keeps
the bus trivial and makes it impossible for a client to see a stale payload.

Consumers:
- **Reconciler** subscribes to collection/row/column events.
- **Runner** subscribes to `generation.updated` (status `queued`) to wake up.
- **SSE endpoint** forwards events to browsers, optionally filtered by collection.
  The UI invalidates the matching TanStack Query keys and refetches; a grid of
  a few hundred cells refetches in one request.
- **MCP** does not get a push channel by default (most agents cannot consume
  one). Instead the command layer offers `collection wait`: block until the
  collection has no queued/running generations, or until a change happens, or
  a timeout elapses. An agent's loop becomes "edit → wait → look at results".
  If a client supports MCP resource subscriptions we can map collection
  resources to the same events later; nothing in the core changes.

---

## 6. The API is a command registry

Every operation is defined once as `{ name, input: zodSchema, output: zodSchema, run }`.
Two thin transports are generated from that registry:

- **HTTP**: `POST /api/<name>` (and a few `GET`s for reads), zod-validated.
- **MCP**: one tool per command, schema converted from zod; read commands
  returning images also return MCP `image` content so an agent can look at a cell.

The registry, grouped:

| Group | Commands |
|---|---|
| models | `list` (with capabilities and settings schema) |
| collections | `list`, `get` (whole grid in one document), `create`, `update`, `delete`, `pause`, `resume`, `duplicate`, `rename`, `export`, `import`, `wait` |
| columns | `add`, `update`, `remove`, `reorder` |
| rows | `add`, `update`, `remove`, `reorder`, `pause`, `resume`, `duplicate` |
| cells | `get` (current + version list), `regenerate`, `retry`, `cancel` |
| generations | `get` (full request snapshot, error, timing) |
| assets | `upload`, `get`, `list`, `label`, `gc` |
| events | `stream` (HTTP only) |

`collections get` is the document an LLM works from: rows with prompts and
inputs, columns with models, and for each cell the current status, asset IDs,
thumbnail URLs, and version count. Compact enough to paste into a context
window for a normal-sized collection.

Design rules for the command layer:
- Accept readable addresses everywhere: `neon-cats/r3/flux-pro`, `neon-cats/r3/flux-pro#2`, plain asset IDs.
- Mutations return the updated object; no separate refetch needed.
- Bulk-friendly: `rows add` accepts an array so an agent can create ten prompts in one call.
- Nothing about generation is imperative except `regenerate`, `retry`, `cancel`. Adding a row to a live collection is how you generate.

---

## 7. UI shape

Routes:
- `/` collections list with status, cell counts, in-flight counts.
- `/c/:slug` the grid. Row header = prompt (inline editable), inputs as
  thumbnails, settings popover, pause toggle. Column header = model, settings
  popover. Cell = current image or status badge (queued / running / failed /
  stale), click for detail. Collection header = live/paused toggle, defaults,
  add column (model picker driven by the registry), add row.
- `/c/:slug/:row/:col` cell detail: large view, version strip, the resolved
  request, error text, regenerate button, "use as input" (drops the asset ID
  into a row's inputs).
- `/assets` library: uploads and generated, filter, label, drag onto rows.

Editing commits on blur/enter, not per keystroke, so a reconcile pass happens
once per edit. The grid reads from one query per collection and invalidates on
SSE events.

---

## 8. Configuration

`imaginator.config.ts` (or env): data directory, port, global concurrency,
per-provider `{ apiKey, concurrency }`. A provider is enabled when its key is
present. The model registry is code; adding a model is adding a `ModelSpec`.

---

## 9. What is deliberately left for later

- Video: `Asset.kind` and `ModelSpec.kind` already allow it; a video adapter
  and a `<video>` cell renderer are the work.
- Pinning a specific version as current instead of "newest matching".
- Cost tracking beyond the optional per-generation number.
- Multi-process runner (lease column, see §4.2).
- Prompt templating or variable expansion across rows. Could be an agent's
  job via MCP rather than a core feature.
- Auth. Localhost tool.

---

## 10. Build order

1. `core`: types, schemas, IDs, `resolve()` + `hash()`, Provider interface.
2. `server`: SQLite schema, asset store, services + event bus, reconciler,
   runner, `mock` provider, HTTP + SSE. At this point `curl` can drive the whole thing.
3. `web`: collections list and grid against the mock provider.
4. Real providers, one at a time: OpenAI, BFL, fal, Google, Replicate.
5. MCP transport over the same command registry.
