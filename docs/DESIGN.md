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
    tmp/      # in-flight downloads and uploads, swept on boot
```

---

## 2. Identifiers

All IDs are short, lowercase, and meant to be typed by humans and LLMs.

| Thing | ID | Example | Notes |
|---|---|---|---|
| Collection | user- or agent-chosen slug | `neon-cats` | Unique globally. Rename allowed via a `rename` command that rewrites references. |
| Column | slug, unique within collection | `flux-pro`, `gpt-image`, `flux-pro-hq` | Defaults to the model's short name. Two columns may point at the same model with different settings or count. |
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
Collection ─┬─ columns[]  (Column: id, model, settings overrides, count, position)
            ├─ rows[]     (Row: id, prompt, inputs[] with roles, settings, paused, position)
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
  defaults: CommonSettings,          // aspect ratio, seed, ...
  columns: Column[],
  rows: Row[],
  createdAt, updatedAt
}
```

### Column
```ts
{ id: 'flux-pro', model: 'bfl/flux-pro-1.1', settings?: ModelSettings, count: number, position: number }
```

`count` is how many outputs each cell in the column asks for (default 1, capped
by the model's `capabilities.count`). It lives on the column, not the row,
because it is part of what the column *is*: a column asking for four samples
is a different experiment from one asking for one.

### Row
```ts
{
  id: 'r3',
  prompt: string,
  negativePrompt?: string,
  inputs: { asset: AssetId, role: 'reference' | 'init' | 'mask', maskFor?: number }[],
  settings?: CommonSettings,         // overrides collection defaults
  paused: boolean,
  position: number,
  notes?: string                     // free text, not part of the request
}
```

Inputs stay in order. Roles express application intent: `reference` (style or
subject guidance), `init` (image-to-image source), `mask` (inpainting region).
A mask's required `maskFor` is the zero-based index of its `init` target;
other roles cannot set it. Adapters map roles to native fields without changing
their meaning. Model validation checks role combinations and per-role counts,
mask/target compatibility, and input MIME, byte and dimension limits. An
unsupported combination makes that cell `unsupported` (§4.1).

### Settings
Two disjoint bags, owned by different things:

- **CommonSettings** (`aspectRatio`, `size`, `seed`, `outputFormat`):
  a small shared vocabulary, supported selectively by models. Owned by the **row**;
  collection defaults fill gaps. Resolution: `collection.defaults` ← `row.settings`.
- **ModelSettings** (`quality`, `style`, `guidance`, `steps`, ...):
  provider-specific knobs declared by the model's zod schema. Owned by the
  **column**; the model's registry defaults fill gaps. Rows cannot set them.

The split is what keeps columns comparable: every cell in a column runs the
same model configuration, and a row can vary the input but never quietly
change what a column means. Validation rejects a row setting a model key or a
column setting a common key.

Each model declares which common keys it honors. An unsupported common key is
dropped at resolution time and the drop is recorded on the generation so the
UI can show "seed ignored by this model". Anything stronger than a dropped
key, such as input images a model cannot take, is never dropped; the cell
becomes `unsupported` instead (§4.1).
Invalid values for supported keys also make the cell `unsupported`. After
dropping unsupported keys, a concrete `size` and `aspectRatio` must agree;
neither silently overrides the other.

### Generation
```ts
{
  id: 'q7m2kd',
  collection: 'neon-cats', row: 'r3', column: 'flux-pro',
  version: 2,                        // ordinal within the cell
  requestHash: 'sha256…',            // hash of the cell's *content*, see §4.1
  request: ResolvedRequest,          // full snapshot; inspectable and reusable later
  status: 'queued' | 'submitting' | 'running' | 'downloading'
        | 'succeeded' | 'failed' | 'cancelled' | 'unsupported' | 'needs_attention',
  providerRef?: ProviderRef,         // durable adapter handle, persisted before monitoring
  pendingOutputs?: PendingOutput[], // remote URLs or staged files; never inline bytes
  outputs: AssetId[],
  error?: { message, code?, retryable },   // also carries the `unsupported` reason
  attempt: number,
  forced: boolean,                   // true = user asked for "another one"
  timing: { queuedAt, startedAt?, finishedAt? },
  cost?: number,
  providerMeta?: unknown             // raw response bits worth keeping
}
```

`ResolvedRequest` records the resolved application request: model, prompt,
negative prompt, input asset IDs with roles and mask targets, count, settings with
registry defaults filled in, the keys that were dropped as unsupported, and
the registry version that did the resolving. Adapters construct native wire
requests from this snapshot. It preserves what was asked without consulting
the current row; it does not guarantee identical images on rerun. The request
snapshot is immutable. `requestHash` is *not* its hash; see §4.1 for why.

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
generation is identified by `requestHash = hash(content(collection, row, column))`.

**The hash covers what the user wrote, not what the provider receives.**
`content()` is:

- the column's model ID, its `settings` as written, and its `count`;
- the row's prompt, negative prompt, and ordered inputs with roles and mask targets;
- the row's common settings after applying collection defaults, with keys the
  model does not honor removed.

Registry defaults, dropped-key records, the registry version, and anything
else `resolve()` adds on the way to the provider are **not** hashed. They are
recorded in the generation's `request` snapshot instead. The distinction is
what makes the identity stable: upgrading the server or changing a model's
default `steps` must never invalidate every cell, while any edit to the
collection's own content must. Removing unhonored keys before hashing means
changing a seed on a model that ignores seeds is also not an edit.

A cell is **satisfied** when it has a generation with that hash in any status
other than `cancelled`. Otherwise the reconciler inserts a new generation with
that hash and a snapshot of the request: `queued` if the row is compatible
with the column's model, `unsupported` if not (see below).

Several generations can share one hash; they are samples of the same request.
The hash is the identity of *what was asked*; the generation's `version`
ordinal distinguishes the samples. Neither a nonce nor a timestamp goes into
the hash. If it did, reverting a prompt after a regenerate would produce a
hash that matches nothing and run again, which is exactly the waste the hash
exists to avoid.

The reconciler runs:
- after any mutation to a collection, its rows, or its columns (debounced ~200ms per collection),
- when a collection is resumed or a row unpaused,
- on server boot,
- never on a timer; there is nothing to discover that an event did not announce.

Consequences that fall out for free:
- Edit a row → only that row's cells get new generations. Other rows are untouched.
- Add a column → every row gets one new cell.
- Revert an edit → the old hash already has a succeeded generation, so nothing
  runs and the newest generation with that hash becomes current again. Version
  history is real history.
- Set a seed on a model that ignores seeds → no new generation, since the key
  is removed before hashing.
- Pause, edit ten things, resume → one reconcile pass, one wave of jobs.
- Restart → reconcile picks up where it left off.
- Provider changes (API keys, concurrency, even model default settings in the
  registry) are *not* part of the hash, so they never trigger regeneration.
  Only the collection's own content does.

**Failed generations do not self-heal.** A `failed`, `unsupported`, or
`needs_attention` generation counts as satisfying the cell until someone runs
`cell retry`; otherwise a broken prompt would burn money forever. Transient
errors (429, 5xx, network) on *safe-to-repeat* calls (polls, downloads,
uploads) retry with backoff up to a small cap inside the runner before the
generation is marked failed. Submission is repeated only when the provider
accepts an idempotency key; a submission that times out without one becomes
`needs_attention`, because it may have been accepted and charged.

**Unsupported combinations make no request.** `resolve()` checks the row
against the column model's capabilities and pure validator: input constraints, negative
prompt, sizes and aspect ratios, and the column's `count` against the model's
maximum. An incompatible pair gets a generation in status
`unsupported` with a specific reason in `error`, and no provider call. Other
columns in the same row still run. Input images are never silently dropped
and a setting the model cannot honor is never approximated. Editing the row
or column changes the hash, so the check simply runs again.

**Superseded work is cancelled.** When a row edit changes a cell's hash while
a generation for the old hash is still in flight:
- `queued`, not yet submitted: marked `cancelled` at once.
- Submitted: call `cancel()` when a handle and that method are available,
  while keeping the result receiver alive. Only `confirmed` marks the
  generation `cancelled`; `pending`, `unsupported`, or no cancellation support
  means monitoring continues. If completion wins the race, store the output
  as `succeeded`. Abort a receiver only after confirmed cancellation or when
  a persisted handle and `resume()` allow monitoring to restart with a fresh
  signal. Never abort a non-resumable response/stream just because it is
  superseded. A local abort is not remote cancellation; completed superseded
  work remains history, not the current cell.

**"Give me another one"** is the one imperative: `cell regenerate` inserts a
new generation with the same hash and `forced: true`. Useful for
non-deterministic models. With a seed set on a model that honors it, a
regenerate legitimately returns the same image; a user who wants variety
clears the seed. The current version of a cell is the newest non-cancelled
generation whose hash matches the desired hash. Pinning an older version as
current is deferred (§9) and would not touch the hash.

### 4.2 The runner

A single in-process loop, one per server:

```
loop:
  pick queued generations, oldest first, where
    provider slots available (per-provider semaphore) and
    global slots available (global semaphore)
  for each: mark submitting (same transaction as the pick), spawn `execute(generation)` (not awaited)
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

**Lifecycle.** A generation moves through persisted phases:

```
queued → submitting → [running, when a job handle exists] → downloading → succeeded
```

`submitting` is written before the provider call. If a job handle is returned,
await `ctx.setProviderRef` to commit it and `running` atomically before any
monitoring. Calls without a handle remain `submitting` until outputs arrive.
Stage inline outputs to durable files first; then commit `downloading` with
`pendingOutputs` containing URLs or staged paths, before downloading remote
outputs. A crash before that commit remains ambiguous, not safe to resubmit.

**Durability.** The `generations` table is the queue. There is no exactly-once
guarantee across a local database and a paid remote API, so recovery is
decided by *where* the process died, and an ambiguous case is surfaced rather
than repeated. On boot, after the reconciler has cancelled stale queued work:

| Persisted state | Recovery |
|---|---|
| `queued` | Picked up normally. |
| `submitting`, no `providerRef` | `needs_attention`. The request may have been accepted and charged; it is never resubmitted automatically. |
| `running` with `providerRef`, adapter has `resume()` | `resume()` monitors the same job. `generate()` is never called again for it. |
| `running` with `providerRef`, no `resume()` | `needs_attention`, handle kept for inspection. |
| `downloading` | Reuse staged files or fetch `pendingOutputs` URLs; never regenerate. Missing files or expired URLs become `failed` with a retrieval error. |

A `needs_attention` generation holds no runner slot but does hold the cell
until `cell retry` inserts a fresh one. The UI shows it distinctly from
`failed`.

This is "durable enough" for a single-user tool without a separate queue
service. If we ever need multiple processes, the loop becomes
`UPDATE … WHERE status='queued' … RETURNING` with a lease column; the rest is unchanged.

### 4.3 Provider adapters

Each provider is a module implementing one small interface. No abstraction
library; we own it.

```ts
type ProviderRef = { version: number; model: string; data: JsonObject };

interface Provider {
  id: string;                          // 'openai', 'bfl', 'fal', 'google', 'replicate', 'mock'
  models: ModelSpec[];
  generate(req: ResolvedRequest, ctx: GenerateContext): Promise<GenerateResult>;
  resume?(providerRef: ProviderRef, ctx: GenerateContext): Promise<GenerateResult>;
  cancel?(providerRef: ProviderRef): Promise<'confirmed' | 'pending' | 'unsupported'>;
}

interface ModelSpec {
  id: string;                          // 'bfl/flux-pro-1.1'
  name: string;
  kind: 'image' | 'video';
  capabilities: {
    inputRoles: string[];              // [] = text-only; e.g. ['reference'], ['init', 'mask']
    maxInputImages: number;
    negativePrompt: boolean;
    commonKeys: (keyof CommonSettings)[];
    count: number;                     // max per request
    aspectRatios?: string[];           // or sizes
    sizes?: string[];
    outputFormats?: string[];
  };
  validateRequest(req: ResolvedRequest, inputs: Asset[]): string[]; // pure; ordered metadata, errors
  settings: ZodObject;                 // model-specific keys, drives UI forms + validation
  concurrency?: number;
}

interface GenerateContext {
  signal: AbortSignal;
  asset(id: AssetId): Promise<{ bytes: Buffer; mime: string; path: string }>;
  setProviderRef(ref: ProviderRef): Promise<void>; // commit handle + running before monitoring
  sleep(ms: number): Promise<void>;             // abortable
  log(msg: string): void;
}

type RemoteOutput = { url: string; mime?: string; meta?: unknown };
type OutputDescriptor = RemoteOutput | { bytes: Buffer; mime: string; meta?: unknown };
type PendingOutput = RemoteOutput | { stagedPath: string; mime: string; meta?: unknown };

interface GenerateResult {
  outputs: OutputDescriptor[];
  cost?: number;
  providerMeta?: unknown;
}
```

`ProviderRef` is versioned, adapter-owned JSON containing everything needed
after restart: model/endpoint, job ID, and returned polling/result/cancel URLs
as applicable. It contains no API keys. Polling is the v1 baseline;
adapters may use provider SSE internally without changing this interface.

Adapters return descriptors, not stored assets; the runner owns persistence.
Input images go the other way: a remote provider cannot fetch a localhost
URL, so adapters read bytes via `ctx.asset()` and upload them or use the
provider's attachment mechanism. Temporary provider upload handles are
execution metadata, not part of the request snapshot.

Adapters that poll do so with `ctx.sleep` and honor `signal`. A shared
`http.ts` helper gives timeout handling and retry-with-backoff on 429/5xx,
**but only for calls the adapter marks as safe to repeat**: polls, downloads,
input uploads. The submission POST is never retried by the helper. An adapter
opts a submission into retry only when it passes a provider idempotency key
and knows the provider honors it; otherwise a failed or timed-out submission
is classified by the adapter as *definitely not accepted* (retryable by the
runner within its budget) or *ambiguous* (becomes `needs_attention`, §4.2).
SDK-level automatic retries are disabled unless their safety is known. Aggregators (fal, Replicate) are one adapter each with
many models in their registry; that is how we get Recraft, Ideogram, and
friends cheaply.

A **`mock` provider** ships from day one: it renders the prompt onto a colored
image with sharp after a random delay and occasionally fails on purpose. In
tests it is controllable: a test can hold a generation open, complete
generations out of order, fail one, or crash the process between phases. The
whole UI and engine can be developed and tested without spending a cent.

### 4.4 Assets

Ingest (`upload` or generation output): stream bytes to `data/tmp/<id>`,
sniff mime, compute sha256, read dimensions, then `rename()` into
`data/assets/<2-char shard>/<id>.<ext>`. Same filesystem, so the rename is
atomic. Only then insert the asset row, and for generation outputs, link the
outputs and mark the generation `succeeded` in the same transaction. The webp
thumbnail may be written afterwards. Originals are never overwritten, and a
missing original is a visible storage error, not a blank cell. Unreferenced files in
`data/tmp` older than a grace period are swept on boot; staged files referenced
by unfinished generations are preserved. A file under `assets/`
with no row is removed by `assets gc`. Served at `/assets/:id` and
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

Every event also carries a **cursor**: a per-collection counter that
increments on each event, alongside a server boot ID. `collections get` and
every mutation return the collection's current cursor. A client that holds a
cursor can ask "has anything happened since?" without guessing, which is what
`collection wait` below is built on. The cursor is in memory only; a cursor
from a previous boot is treated as stale and any wait on it returns at once.

Consumers:
- **Reconciler** subscribes to collection/row/column events.
- **Runner** subscribes to `generation.updated` (status `queued`) to wake up.
- **SSE endpoint** forwards events to browsers, optionally filtered by collection.
  The UI invalidates the matching TanStack Query keys and refetches; a grid of
  a few hundred cells refetches in one request. On reconnect the UI simply
  refetches; there is no replay log, since a refetch is the recovery.
- **MCP** does not get a push channel by default (most agents cannot consume
  one). Instead the command layer offers `collection wait { cursor, timeout }`:
  return as soon as the collection's cursor is past the given one, or when the
  timeout elapses. The response carries the new cursor and whether any
  generations are still queued or in flight. Waiting on a cursor rather than
  on "nothing is running" matters because of the reconcile debounce: right
  after an edit, nothing is queued yet, and an idle check would return
  immediately with stale results. An agent's loop is "mutate (get cursor) →
  wait(cursor) → get, repeat while in flight". If a client supports MCP
  resource subscriptions we can map collection resources to the same events
  later; nothing in the core changes.

---

## 6. The API is a command registry

Every operation is defined once as `{ name, input: zodSchema, output: zodSchema, run }`.
Two thin transports are generated from that registry:

- **HTTP**: `POST /api/<name>` (and a few `GET`s for reads), zod-validated.
- **MCP**: a curated set of tools over the same registry (not one per
  command), schema converted from zod; see §6.1.

The registry, grouped:

| Group | Commands |
|---|---|
| models | `list` (with capabilities and settings schema) |
| collections | `list`, `get` (whole grid in one document), `create`, `update`, `delete`, `pause`, `resume`, `duplicate`, `rename`, `export`, `import`, `wait` |
| columns | `add`, `update`, `remove`, `reorder` |
| rows | `add`, `update`, `remove`, `reorder`, `pause`, `resume`, `duplicate` |
| cells | `get` (current + version list), `regenerate`, `retry` (failed, unsupported, needs_attention), `cancel` |
| generations | `get` (full request snapshot, error, timing) |
| assets | `upload`, `get`, `list`, `label`, `gc` |
| events | `stream` (HTTP only) |

`collections get` is the document an LLM works from: rows with prompts and
inputs, columns with models, and for each cell the current status, asset IDs,
thumbnail URLs, and version count. Compact enough to paste into a context
window for a normal-sized collection.

### 6.1 MCP surface

The MCP server is hosted by the same process (Streamable HTTP at `/mcp`,
serving both the 2026-07-28 revision and 2025-era sessions, plus a stdio
bridge that forwards to it so the engine never runs twice). It is a client of
the command registry, but it is not a 1:1 projection of it:

- **Tools carry the workflow.** Agents get `create_collection` with rows and
  columns inline, `add_rows`/`add_columns`, `update_row`/`update_column`,
  `wait_for_collection`, `get_collection`, `get_cell`, `view_images`,
  `regenerate_cell`/`retry_cell`/`cancel_cell`, and `upload_asset`. UI-only
  commands (reorder, rename, duplicate, import/export, labels, gc) are HTTP
  only. Pause/resume fold into `update_collection { status }` and
  `update_row { paused }`.
- **Images go inline in tool results.** That is the one path every client
  that can show a model an image actually implements. Each image is preceded
  by a text label with its address, because a model cannot otherwise tell
  which image is which. `small` (<=512px webp) is the default because some
  clients meter results by raw bytes; `full` is capped at 1568px, above
  which vision models downscale anyway. Results also carry
  `structuredContent` (validated against an `outputSchema`) plus the same
  JSON as text for clients without structured output.
- **Resources mirror the read side** (`imaginator://collections/{slug}`,
  `imaginator://assets/{id}`, `.../thumb`, `imaginator://models`) for
  clients that let users attach them, with `resources/subscribe` mapped to
  the event bus. Nothing in the agent loop depends on them.
- **`wait_for_collection` replaces push.** It long-polls on the cursor (§5)
  and emits `notifications/progress` when the client asks; that works in
  every client, whereas resource subscriptions and MCP tasks do not.

The client behaviour these choices rest on (which clients show the model
tool-result images, who reads resources, size limits, protocol eras) is
written up with sources in `docs/MCP-CLIENTS.md`.

Design rules for the command layer:
- Accept readable addresses everywhere: `neon-cats/r3/flux-pro`, `neon-cats/r3/flux-pro#2`, plain asset IDs.
- Mutations return the updated object and the collection's cursor; no separate refetch needed.
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

- Provider webhooks and live progress/preview UI. Later, add separate optional
  status, numeric progress, and preview callbacks to `GenerateContext`;
  queue status is not an image preview, and previews are not final outputs.
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

**Verification.** The cases worth a test each, run against a temporary SQLite
file and the controllable mock provider: duplicate commands; row-only and
column-only invalidation; pause, edit several things, resume; out-of-order
completions; edits during active runs; partial row failure; cancellation
races including completion beating a `pending` cancel; crash between
`submitting` and `providerRef`; restart during polling; restart during
download; pinned inputs surviving regeneration of their source cell; SSE
reconnect after missed events; revert after regenerate finds the old hash
with no new run; registry default change causes no new runs; `wait` on a
cursor taken before an edit returns only after the reconcile pass; ambiguous
submission timeout lands in `needs_attention` and is never resubmitted;
superseding a non-resumable stream preserves its result; staged inline outputs
survive restart; invalid input/mask combinations make no provider call.
