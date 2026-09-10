# Imaginator — Core Design

A personal workbench for image (later video) generation models, shaped like a
spreadsheet. A **collection** is a grid: rows are prompts, columns are models,
and every cell is the picture that model made for that prompt. Cells can take
other cells' outputs as inputs, so the grid recalculates the way a sheet does:
change a prompt, regenerate a base image, or pin a different version, and
everything downstream follows. Comparing models side by side, editing an image
in a multi-turn chain, and piping one model's output through another are all
the same mechanism.

The backend keeps every live collection "filled in" by generating whatever
cells are missing or stale. A UI and an MCP server are two clients of the same
core API.

This document covers the stack, the domain model, the generation engine, and
the shape of the API. It deliberately does not spell out HTTP routes or MCP
tool signatures; those are derived from the command layer described in §6.

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
queued jobs for provider X", "which collections reference this one", and
atomic multi-row updates. SQLite gives that with no server. We keep
portability by adding `collection export/import` as JSON commands; a
collection is fully described by one JSON document plus the assets it
references.

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
| Column | slug, unique within collection | `flux-pro`, `gpt-image`, `flux-pro-hq` | Defaults to the model's short name. Two columns may point at the same model with different settings, count, or recipe. May never match the row shape below. |
| Row | `r` + per-collection counter, never reused | `r1`, `r7` | Stable across reordering. Gaps after deletes are fine. The `r` + digits shape is reserved for rows, so any address segment says what it is by its shape. |
| Cell | path `collection/row/column` | `neon-cats/r3/flux-pro` | Not stored; derived address for a (row, column) pair. |
| Reference | partial cell address | `r3`, `flux-pro`, `r3/flux-pro`, `neon-cats/r3/flux-pro` | A live input pointing at another cell's current output. Which parts may be omitted depends on where it is written (§3, References). |
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
Collection ─┬─ columns[]  (Column: model, settings, count, recipe = prompt template + inputs)
            ├─ rows[]     (Row: prompt, inputs[], common settings, columns?, paused)
            └─ defaults   (common settings applied to every row unless overridden)

Cell (row × column) = column recipe applied to row
        └─ generations[]  (history; current = pinned, else newest matching)
                └─ outputs[] → Asset

Input = frozen Asset | live reference to another cell's current output
Asset (uploaded | generated) = file on disk + thumbnail + dimensions + mime
```

The one structural rule: **a cell never carries its own prompt or inputs.**
Every cell is a column recipe applied to a row. This is where we part from a
spreadsheet, deliberately: rows stay comparable across models and columns
stay comparable across prompts, and the grid remains readable however long
the pipelines get. Everything below is built so that the simple reading,
"rows are prompts, columns are models", stays true until you ask for more:

1. Rows are prompts, columns are models. A column without a recipe is a model.
2. "Follow up" on a cell adds a row that references the row above: a
   multi-turn edit, one conversation per model, side by side.
3. "Use as input" can drop a frozen asset or a live reference into a row,
   optionally naming a column or another collection.
4. A column recipe can add inputs of its own and rewrite the prompt, which
   turns the column into a pipeline stage.

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
{
  id: 'flux-pro',
  model: 'bfl/flux-pro-1.1',
  settings?: ModelSettings,          // provider-specific knobs, registry defaults fill gaps
  count: number,                     // outputs per cell; capped by the model
  position: number,
  prompt?: string,                   // template; default '{prompt}'
  inputs?: (Input | { rowInputs: true })[],   // default [{ rowInputs: true }]
}
```

`count` is how many outputs each cell in the column asks for (default 1,
capped by the model's `capabilities.count`). It lives on the column, not the
row, because it is part of what the column *is*: a column asking for four
samples is a different experiment from one asking for one.

`prompt` and `inputs` are the column's **recipe**: how it builds a cell out
of the row. Both default to "the row, verbatim", so a column with no recipe
is simply a model. See "Column recipes" below.

### Row
```ts
{
  id: 'r3',
  prompt: string,
  negativePrompt?: string,
  inputs: Input[],                   // frozen assets or live references
  settings?: CommonSettings,         // overrides collection defaults
  columns?: ColumnId[],              // sparse row: run only in these columns; absent = all
  paused: boolean,
  position: number,
  notes?: string                     // free text, not part of the request
}
```

### Inputs
```ts
type Role = 'reference' | 'init' | 'mask';
type Input =
  | { asset: AssetId, role: Role, maskFor?: number }                       // frozen
  | { row?: RowId, column?: ColumnId, collection?: CollectionSlug,        // live
      output?: number, role: Role, maskFor?: number }
```

Inputs stay in order. Roles express application intent: `reference` (style
or subject guidance), `init` (image-to-image source), `mask` (inpainting
region). A mask's required `maskFor` is the zero-based index of its `init`
target; other roles cannot set it. Adapters map roles to native fields
without changing their meaning. Model validation checks role combinations
and per-role counts, mask/target compatibility, and input MIME, byte and
dimension limits. An unsupported combination makes that cell `unsupported`
(§4.1).

An asset input is a **frozen** picture: "use as input" copies an asset ID and
it never moves. A reference is a **live** input: it names another cell and
resolves, every time the cell is looked at, to that cell's *current* output
(`output` indexes the outputs when the source column asks for several;
default 0). A reference is a formula, an asset is a pasted value.

### References

A reference is a partial cell address. The anchors it leaves out are filled
in from the cell being resolved, and which anchors may be left out depends on
where the reference is written. This is Excel's relative/absolute
distinction, with rows and columns carrying the meaning they have here:

| Written on | `r3` | `flux` | `r3/flux` | `moonbase/r3/flux` |
|---|---|---|---|---|
| a row | row r3, *same column* | not allowed | that cell, for every column | that cell in another collection |
| a column | not allowed | *same row*, column flux | that cell, for every row | that cell in another collection |

A reference written on a row must name a row; one written on a column must
name a column; one into another collection is always a full address.
Commands accept the object form and the address string interchangeably.

What the forms are for:

- **`r3` on a row** is a follow-up edit: "add a hat" under "a cat". It
  resolves per column, so the follow-up runs once per model on that model's
  own base, and a chain of edits reads top to bottom per column. This is a
  multi-turn conversation with each model, side by side.
- **`r1/flux` on a row** pins one base for every model: "film grain" applied
  to the same Flux image by every column, to compare who styles best.
- **`flux` on a column** makes the column a pipeline stage: "same row,
  Flux's output". See "Column recipes".
- **`moonbase/r1/flux`** is another sheet. A collection with one column and
  four rows, each referencing a different column of another collection, runs
  one style model over four structure models. That is a pivot, and a
  spreadsheet pivots with another sheet too.

References may form any tree or DAG: a row may reference several cells, and
several cells may reference the same one. They may not form a cycle, and a
cell may not reference itself. The check runs at write time on the
**concrete cell graph**: every row and column reference expanded to actual
cells, across collections. Grids are a few hundred cells, so a plain DFS is
exact. The resolver keeps a visiting guard as the backstop that turns
anything it would otherwise loop on into a blocked cell with a reason.

A **reference index** (`row_refs`, `column_refs`: who references which
collection, row, column) is maintained in the same transaction as row and
column writes. It answers "which collections depend on this one" for
invalidation (§4.1), "what feeds this cell and what does it feed" for the
cell page (precedents and dependents, the trace arrows), and enforces the
integrity rules: removing a row, a column, or a collection that something
references is refused with the dependants listed; renaming a collection
rewrites the references into it. Duplicating a row or a collection, and
export/import, keep references as written; references into other
collections must resolve on import.

### Column recipes

A column is a model plus a recipe for turning the row into a request. The
recipe has two parts and both default to "the row, verbatim":

- **`prompt`** is a template. `{prompt}` is the row's prompt, and the default
  template is `{prompt}`. A style column might use `{prompt}, woodcut print,
  heavy black ink`. An editing model wants an instruction rather than a
  description, so a film-grain stage might use `add heavy 35mm film grain,
  keep composition and subject` with no placeholder at all. Whether a
  refining column sees the row's prompt is the column's decision.
- **`inputs`** is an ordered list whose default is one entry, the placeholder
  `{ rowInputs: true }`: the row's inputs, at that position. A column can add
  frozen assets around it, `[row inputs, style.png as reference]`, meaning
  "this model, always with this style reference". A stage column drops the
  placeholder: `[{ column: 'flux', role: 'init' }]` means the cell takes the
  same row's Flux output and *not* the row's inputs, because those already
  went into Flux. Making the placeholder explicit, rather than always
  appending column inputs to row inputs, is what lets follow-up rows and
  stage columns coexist without two `init` images colliding.

A row's `maskFor` indices count within the row's inputs and are shifted by
the placeholder's position when the recipe is expanded.

Reading a row left to right across stage columns is a pipeline. With
columns `flux`, `film` (Kontext, recipe `[flux → init]`, an instruction
template), `upscale` (recipe `[film → init]`) and `nano` (plain):

```
          flux         film             upscale           nano
r1  cat   flux(cat)    film(r1/flux)    upscale(r1/film)  nano(cat)
r2  ↳r1   flux(edits   film(r2/flux)    upscale(r2/film)  nano: unsupported
            r1/flux)                                       (cannot take init)
```

Flux makes the image, Kontext adds grain to it, the upscaler finishes it,
and Nano Banana's cell is an unrelated comparison. Row r2 is a follow-up on
r1 written the ordinary way: in `flux` it edits r1's Flux image; in `film`
the recipe ignores the row's reference and takes r2/flux, the edited base,
so the grain stage re-applies to the edit. "Stage" is not a concept the
engine knows. A stage is a column whose recipe references another column,
and it waits, runs, and reruns like any cell.

### Settings
Two disjoint bags, owned by different things:

- **CommonSettings** (`aspectRatio`, `size`, `seed`, `outputFormat`): a
  small shared vocabulary, supported selectively by models. Owned by the
  **row**; collection defaults fill gaps. Resolution: `collection.defaults`
  ← `row.settings`.
- **ModelSettings** (`quality`, `style`, `guidance`, `steps`, ...):
  provider-specific knobs declared by the model's zod schema. Owned by the
  **column**; the model's registry defaults fill gaps. Rows cannot set them.

The split is what keeps columns comparable: every cell in a column runs the
same model configuration and the same recipe, and a row can vary what goes
in but never quietly change what a column means. Validation rejects a row
setting a model key or a column setting a common key.

Each model declares which common keys it honors. An unsupported common key
is dropped at resolution time and the drop is recorded on the generation so
the UI can show "seed ignored by this model". Anything stronger than a
dropped key, such as input images a model cannot take, is never dropped; the
cell becomes `unsupported` instead (§4.1). Invalid values for supported keys
also make the cell `unsupported`. After dropping unsupported keys, a concrete
`size` and `aspectRatio` must agree; neither silently overrides the other.

### Current version and pins

A cell's **current** version is the newest non-cancelled generation whose
hash matches the cell's desired hash (§4.1), unless a **pin** says
otherwise. A pin names one generation of a cell as current. It is honored
only while that generation's hash still equals the desired hash, so editing
the content clears it naturally; a pin is never a way to show a stale
picture as current.

Pins are what make "current" yours once references exist. Regenerate a base
three times, pin #2, and everything downstream builds on #2; regenerate more
and nothing moves; pin #5 and the chain reruns once. A frozen asset cannot
do this job: a row has one inputs list shared by all columns, so an asset
means the same picture in every column, whereas a pin picks a version for
one column and leaves the per-column references intact. Pins live on the
source; freezing would mean editing every consumer.

### Sparse rows

A row may list the columns it runs in. Cells outside that list are
`skipped`: no generation, no cost, and a reference to a skipped cell is
blocked with "r3/flux is skipped". This is the empty cell of a spreadsheet,
and it is how a follow-up meant only for one model runs only there.

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

`ResolvedRequest` records the resolved application request: model, the
rendered prompt, negative prompt, input asset IDs with roles and mask targets
(references already resolved), count, settings with registry defaults filled
in, the keys that were dropped as unsupported, and the registry version that
did the resolving. Adapters construct native wire requests from this
snapshot. It preserves what was asked without consulting the current row; it
does not guarantee identical images on rerun. The request snapshot is
immutable, so an old version of a follow-up always shows the exact base it
was made from. `requestHash` is *not* its hash; see §4.1 for why.

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

For every live collection, every non-paused row, and every column the row
runs in, the desired generation is identified by
`requestHash = hash(content(collection, row, column))`.

**The hash covers what the cell asks for, not what the provider receives.**
`content()` is:

- the column's model ID, its `settings` as written, and its `count`;
- the prompt after the column template is rendered, and the negative prompt;
- the ordered inputs after the column recipe is expanded, with roles and
  mask targets, where every reference is replaced by the asset ID of the
  source cell's current output;
- the row's common settings after applying collection defaults, with keys
  the model does not honor removed.

Registry defaults, dropped-key records, the registry version, and anything
else `resolve()` adds on the way to the provider are **not** hashed. They
are recorded in the generation's `request` snapshot instead. The distinction
is what makes the identity stable: upgrading the server or changing a
model's default `steps` must never invalidate every cell, while any edit to
the collection's own content must. Removing unhonored keys before hashing
means changing a seed on a model that ignores seeds is also not an edit.

Templates and references are hashed by what they *resolve to*, never as
written. A template that renders to the same text as a literal prompt, and a
reference that resolves to the same asset as a frozen input, are the same
content and do not rerun. This makes recipes and references safe to
refactor, and it is why a cell's hash literally contains the picture it was
made from. Propagation needs no notification, only recalculation: each pass
recomputes every cell's hash and asks whether a generation with that hash
exists.

**Resolution is workbook-wide.** The resolver for a pass is scoped to the
reconciling collection but lazily loads any collection a reference points
into, memoized for the pass, reading inside the same transaction. Resolving
a cell resolves its sources first, recursively, so a chain of any length
resolves in one pass as far as its finished sources allow.

A cell is **satisfied** when it has a generation with the desired hash in
any status other than `cancelled`. Otherwise the reconciler inserts a new
generation with that hash and a snapshot of the request: `queued` if the row
is compatible with the column's model, `unsupported` if not (see below).

A cell with a reference that has nothing to resolve to is **blocked**: the
source cell has no current generation yet, it is still running, it ended
`failed`, `unsupported`, or `needs_attention`, it is skipped, or its
collection is paused. A blocked cell has no desired generation, so nothing
is inserted and the grid shows `blocked` with the reason ("waiting for r3",
"r3 failed", "waiting for moonbase/r3/flux"). Blocking is transitive down a
chain and clears by itself: the source succeeding is an event, and the next
pass resolves the cell. Regenerate and retry refuse a blocked cell. A
`skipped` cell (sparse row) is neither blocked nor missing; it is not part
of the grid's desired state at all.

Several generations can share one hash; they are samples of the same
request. The hash is the identity of *what was asked*; the generation's
`version` ordinal distinguishes the samples. Neither a nonce nor a timestamp
goes into the hash. If it did, reverting a prompt after a regenerate would
produce a hash that matches nothing and run again, which is exactly the
waste the hash exists to avoid.

The reconciler runs:
- after any mutation to a collection, its rows, or its columns (debounced
  ~200ms per collection),
- after a generation succeeds or a pin changes: for that collection, and
  for every collection the reference index says depends on it, since a cell
  blocked on the source may now resolve and cells referencing it now have
  new content,
- when a collection is resumed or a row unpaused,
- on server boot,
- never on a timer; there is nothing to discover that an event did not
  announce.

Consequences that fall out for free:
- Edit a row → that row's cells get new generations, then whatever
  references them, hop by hop. Rows nothing depends on are untouched.
- Add a column → every row gets one new cell.
- Revert an edit → the old hash already has a succeeded generation, so
  nothing runs and the newest generation with that hash becomes current
  again. Downstream cells find their old hashes too. Version history is
  real history, and reverting a four-hop chain costs zero generations.
- Set a seed on a model that ignores seeds → no new generation, since the
  key is removed before hashing.
- Pause, edit ten things, resume → one reconcile pass, one wave of jobs.
- Restart → reconcile picks up where it left off.
- Provider changes (API keys, concurrency, even model default settings in
  the registry) are *not* part of the hash, so they never trigger
  regeneration. Only the collection's own content does.
- Regenerate a cell that other cells reference → its new sample becomes
  current (unless the cell is pinned), so every dependent gets new content
  and runs again, hop by hop, in whatever collection it lives. Only cells
  whose resolved inputs actually changed move: regenerating r1/flux touches
  the Flux column's chain and any stage columns fed by it, never the Nano
  Banana column's chain. Old generations stay in history with the exact
  base they were made from.
- Pin a version → dependents recalculate against it once; further
  regenerates of the pinned cell change nothing downstream.
- Edit a column's template → only that column and what depends on it rerun.
- Pause a row that others depend on → its dependents show blocked and stop,
  which is the throttle for exploring a base without paying for its chain.

**Failed generations do not self-heal.** A `failed`, `unsupported`, or
`needs_attention` generation counts as satisfying the cell until someone
runs `cell retry`; otherwise a broken prompt would burn money forever.
Transient errors (429, 5xx, network) on *safe-to-repeat* calls (polls,
downloads, uploads) retry with backoff up to a small cap inside the runner
before the generation is marked failed. Submission is repeated only when the
provider accepts an idempotency key; a submission that times out without one
becomes `needs_attention`, because it may have been accepted and charged.

**Unsupported combinations make no request.** `resolve()` checks the
expanded request against the column model's capabilities and pure validator:
input constraints, negative prompt, sizes and aspect ratios, and the
column's `count` against the model's maximum. An incompatible pair gets a
generation in status `unsupported` with a specific reason in `error`, and no
provider call. Other columns in the same row still run. Input images are
never silently dropped and a setting the model cannot honor is never
approximated. Editing the row or column changes the hash, so the check
simply runs again.

**Superseded work is cancelled.** When a cell's hash changes while a
generation for the old hash is still in flight:
- `queued`, not yet submitted: marked `cancelled` at once.
- Submitted: call `cancel()` when a handle and that method are available,
  while keeping the result receiver alive. Only `confirmed` marks the
  generation `cancelled`; `pending`, `unsupported`, or no cancellation
  support means monitoring continues. If completion wins the race, store
  the output as `succeeded`. Abort a receiver only after confirmed
  cancellation or when a persisted handle and `resume()` allow monitoring
  to restart with a fresh signal. Never abort a non-resumable
  response/stream just because it is superseded. A local abort is not
  remote cancellation; completed superseded work remains history, not the
  current cell.

**"Give me another one"** is the one imperative: `cell regenerate` inserts a
new generation with the same hash and `forced: true`. Useful for
non-deterministic models. With a seed set on a model that honors it, a
regenerate legitimately returns the same image; a user who wants variety
clears the seed. `cell pin` and `cell unpin` change which version is current
and therefore what dependents see; they never touch the hash.

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
the loop; every provider wait is an `await` on `fetch` or `setTimeout`. With
a few dozen in-flight generations the process is idle almost all the time,
since the real work happens at the provider. The runner knows nothing about
references: by the time a generation is queued, its inputs are asset IDs.

Concurrency limits live in config: a global cap and a per-provider cap
(OpenAI might allow 5, a small provider 2). The `models` registry can give a
per-model default.

**Lifecycle.** A generation moves through persisted phases:

```
queued → submitting → [running, when a job handle exists] → downloading → succeeded
```

`submitting` is written before the provider call. If a job handle is
returned, await `ctx.setProviderRef` to commit it and `running` atomically
before any monitoring. Calls without a handle remain `submitting` until
outputs arrive. Stage inline outputs to durable files first; then commit
`downloading` with `pendingOutputs` containing URLs or staged paths, before
downloading remote outputs. A crash before that commit remains ambiguous,
not safe to resubmit.

**Durability.** The `generations` table is the queue. There is no
exactly-once guarantee across a local database and a paid remote API, so
recovery is decided by *where* the process died, and an ambiguous case is
surfaced rather than repeated. On boot, after the reconciler has cancelled
stale queued work:

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
`UPDATE … WHERE status='queued' … RETURNING` with a lease column; the rest
is unchanged.

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
after restart: model/endpoint, job ID, and returned polling/result/cancel
URLs as applicable. It contains no API keys. Polling is the v1 baseline;
adapters may use provider SSE internally without changing this interface.

Adapters return descriptors, not stored assets; the runner owns persistence.
Input images go the other way: a remote provider cannot fetch a localhost
URL, so adapters read bytes via `ctx.asset()` and upload them or use the
provider's attachment mechanism. Temporary provider upload handles are
execution metadata, not part of the request snapshot.

Adapters that poll do so with `ctx.sleep` and honor `signal`. A shared
`http.ts` helper gives timeout handling and retry-with-backoff on 429/5xx,
**but only for calls the adapter marks as safe to repeat**: polls, downloads,
input uploads. The submission POST is never retried by the helper. An
adapter opts a submission into retry only when it passes a provider
idempotency key and knows the provider honors it; otherwise a failed or
timed-out submission is classified by the adapter as *definitely not
accepted* (retryable by the runner within its budget) or *ambiguous*
(becomes `needs_attention`, §4.2). SDK-level automatic retries are disabled
unless their safety is known. Aggregators (fal, Replicate) are one adapter
each with many models in their registry; that is how we get Recraft,
Ideogram, and friends cheaply.

A **`mock` provider** ships from day one: it renders the prompt onto a
colored image with sharp after a random delay and occasionally fails on
purpose. In tests it is controllable: a test can hold a generation open,
complete generations out of order, fail one, or crash the process between
phases. The whole UI and engine can be developed and tested without spending
a cent.

### 4.4 Assets

Ingest (`upload` or generation output): stream bytes to `data/tmp/<id>`,
sniff mime, compute sha256, read dimensions, then `rename()` into
`data/assets/<2-char shard>/<id>.<ext>`. Same filesystem, so the rename is
atomic. Only then insert the asset row, and for generation outputs, link the
outputs and mark the generation `succeeded` in the same transaction. The
webp thumbnail may be written afterwards. Originals are never overwritten,
and a missing original is a visible storage error, not a blank cell.
Unreferenced files in `data/tmp` older than a grace period are swept on
boot; staged files referenced by unfinished generations are preserved. A
file under `assets/` with no row is removed by `assets gc`. Served at
`/assets/:id` and `/assets/:id/thumb` with long cache headers, since content
never changes.

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
cursor can ask "has anything happened since?" without guessing, which is
what `collection wait` below is built on. The cursor is in memory only; a
cursor from a previous boot is treated as stale and any wait on it returns
at once.

Consumers:
- **Reconciler** subscribes to collection/row/column events, and to
  `generation.updated` with status `succeeded` and to pin changes, fanning
  out to dependent collections through the reference index.
- **Runner** subscribes to `generation.updated` (status `queued`) to wake up.
- **SSE endpoint** forwards events to browsers, optionally filtered by
  collection. The UI invalidates the matching TanStack Query keys and
  refetches; a grid of a few hundred cells refetches in one request. On
  reconnect the UI simply refetches; there is no replay log, since a refetch
  is the recovery.
- **MCP** does not get a push channel by default (most agents cannot consume
  one). Instead the command layer offers `collection wait { cursor, timeout }`:
  return as soon as the collection's cursor is past the given one, or when
  the timeout elapses. The response carries the new cursor and whether any
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
| columns | `add`, `update` (model, settings, count, recipe), `remove`, `reorder` |
| rows | `add`, `update` (prompt, inputs, settings, columns), `remove`, `reorder`, `pause`, `resume`, `duplicate` |
| cells | `get` (current, version list, precedents and dependents), `regenerate`, `retry` (failed, unsupported, needs_attention), `cancel`, `pin`, `unpin` |
| generations | `get` (full request snapshot, error, timing) |
| assets | `upload`, `get`, `list`, `label`, `gc` |
| events | `stream` (HTTP only) |

`collections get` is the document an LLM works from: rows with prompts and
inputs, columns with models and recipes, and for each cell the current
status, asset IDs, thumbnail URLs, version count, and the blocked reason
when there is one. Compact enough to paste into a context window for a
normal-sized collection.

Design rules for the command layer:
- Accept readable addresses everywhere: `neon-cats/r3/flux-pro`,
  `neon-cats/r3/flux-pro#2`, plain asset IDs. References are accepted both
  as objects (`{ row, column, collection, output, role }`) and as partial
  address strings (`r3`, `r3/flux`, `moonbase/r3/flux`), normalized to the
  object form.
- Mutations return the updated object and the collection's cursor; no
  separate refetch needed.
- Bulk-friendly: `rows add` accepts an array so an agent can create ten
  prompts in one call, and rows in one batch may reference each other.
- Nothing about generation is imperative except `regenerate`, `retry`,
  `cancel`, `pin`, `unpin`. Adding a row to a live collection is how you
  generate.

### 6.1 MCP surface

The MCP server is hosted by the same process (Streamable HTTP at `/mcp`,
serving both the 2026-07-28 revision and 2025-era sessions, plus a stdio
bridge that forwards to it so the engine never runs twice). It is a client
of the command registry, but it is not a 1:1 projection of it:

- **Tools carry the workflow.** Agents get `create_collection` with rows and
  columns inline, `add_rows`/`add_columns`, `update_row`/`update_column`,
  `wait_for_collection`, `get_collection`, `get_cell`, `view_images`,
  `regenerate_cell`/`retry_cell`/`cancel_cell`/`pin_cell`, and
  `upload_asset`. UI-only commands (reorder, rename, duplicate,
  import/export, labels, gc) are HTTP only. Pause/resume fold into
  `update_collection { status }` and `update_row { paused }`. Tool
  descriptions explain references and recipes in one sentence each, since
  an agent chaining edits or building a pipeline needs only the address
  grammar.
- **Images go inline in tool results.** That is the one path every client
  that can show a model an image actually implements. Each image is
  preceded by a text label with its address, because a model cannot
  otherwise tell which image is which. `small` (<=512px webp) is the default
  because some clients meter results by raw bytes; `full` is capped at
  1568px, above which vision models downscale anyway. Results also carry
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

---

## 7. UI shape

Routes:
- `/` collections list with status, cell counts, in-flight counts.
- `/c/:slug` the grid. Row header = prompt (inline editable), inputs as
  thumbnails (a reference shows as an address chip, `↳ r3`), settings
  popover, pause toggle, "add follow-up row". Column header = model,
  settings popover, and a `← flux` marker when the column's recipe
  references another column, so a pipeline is readable off the headers.
  Cell = current image or status badge (queued / running / failed / blocked
  / skipped), click for detail. Collection header = live/paused toggle,
  defaults, add column (model picker driven by the registry), add row.
- `/c/:slug/:row/:col` cell detail: large view with a fullscreen mode that
  keeps arrow-key navigation between cells, version strip with pin, the
  resolved request, error or blocked reason, regenerate, "follow up", "use
  as input" (frozen asset, or a live reference with optional column and
  collection), and the cell's precedents and dependents as links.
- `/assets` library: uploads and generated, filter, label, drag onto rows.

The features layer so the basics stay untouched. Rows are prompts and
columns are models; nothing else is visible until asked for. "Follow up" on
a cell is the first reference anyone meets. "Use as input" is where absolute
and cross-collection references appear, next to the frozen asset. The
column editor keeps the recipe in a collapsed section showing `{prompt}` and
a single "row inputs" chip, which is the default recipe spelled out; adding
a column reference there makes a stage. A user who never opens it never sees
any of this.

Editing commits on blur/enter, not per keystroke, so a reconcile pass happens
once per edit. The grid reads from one query per collection and invalidates
on SSE events.

---

## 8. Configuration

`imaginator.config.ts` (or env): data directory, port, global concurrency,
per-provider `{ apiKey, concurrency }`. A provider is enabled when its key is
present. The model registry is code; adding a model is adding a `ModelSpec`.

---

## 9. What is deliberately left for later

- Provider webhooks and live progress/preview UI. Later, add separate
  optional status, numeric progress, and preview callbacks to
  `GenerateContext`; queue status is not an image preview, and previews are
  not final outputs.
- Video: `Asset.kind` and `ModelSpec.kind` already allow it; a video adapter
  and a `<video>` cell renderer are the work.
- Cost tracking beyond the optional per-generation number, and a preview of
  what a regenerate or pin will cascade into before it runs.
- "Paste values": turn a reference into the asset it currently resolves to.
- Dependency highlighting in the grid (precedents and dependents on hover).
- Multi-process runner (lease column, see §4.2).
- Variable expansion across rows (`{name}` bound per row). Column templates
  cover the pipeline case; row-level variables may be an agent's job via
  MCP.
- Cells whose output is text rather than an image: a prompt-writing model as
  a column, referenced by an image row as its prompt. The reference model
  already allows it; the asset kind and a text renderer are the work.
- Auth. Localhost tool.

---

## 10. Build order

1. `core`: types, schemas, IDs, `resolve()` + `hash()`, Provider interface.
2. `server`: SQLite schema, asset store, services + event bus, reconciler,
   runner, `mock` provider, HTTP + SSE. At this point `curl` can drive the
   whole thing.
3. `web`: collections list and grid against the mock provider.
4. Real providers, one at a time: OpenAI, BFL, fal, Google, Replicate.
5. MCP transport over the same command registry.
6. Same-column row references (`r3` on a row), blocked cells, and the
   reconciler pass on succeeded generations.
7. **General references.** Optional column and collection anchors on row
   references, the reference index, the workbook resolver, cross-collection
   invalidation, cycle detection on the concrete cell graph, delete refusal
   and rename rewriting, partial-address parsing in the command layer, the
   live-reference option in "use as input", precedents and dependents on the
   cell page.
8. **Pins and sparse rows.** `cell pin`/`unpin` with the hash-match rule and
   its invalidation; `row.columns` and the `skipped` cell status.
9. **Column recipes.** `column.prompt` templates and `column.inputs` with
   the row-inputs placeholder; the recipe section in the column editor; the
   stage marker in column headers.

Steps 1 to 6 are built. Each remaining step is usable on its own.

**Verification.** The cases worth a test each, run against a temporary
SQLite file and the controllable mock provider:

- Engine basics: duplicate commands; row-only and column-only invalidation;
  pause, edit several things, resume; out-of-order completions; edits during
  active runs; partial row failure; cancellation races including completion
  beating a `pending` cancel; crash between `submitting` and `providerRef`;
  restart during polling; restart during download; frozen inputs surviving
  regeneration of their source cell; SSE reconnect after missed events;
  revert after regenerate finds the old hash with no new run; registry
  default change causes no new runs; `wait` on a cursor taken before an edit
  returns only after the reconcile pass; ambiguous submission timeout lands
  in `needs_attention` and is never resubmitted; superseding a non-resumable
  stream preserves its result; staged inline outputs survive restart;
  invalid input/mask combinations make no provider call.
- References: a follow-up row runs after its base on the base output of the
  same column; regenerating a base cascades down its column only; a
  follow-up is blocked while its base is missing, failed, or paused and
  fills once it succeeds; a queued follow-up is superseded when its base
  changes mid-flight; reference validation (unknown, self, cycle, removal
  of a referenced row); an absolute reference feeds the same picture to
  every column; a reference into another collection follows that
  collection's regenerations and blocks while it is paused; a
  cross-collection cycle is refused; renaming a collection keeps references
  into it working; reverting a base finds the whole old chain with no runs.
- Pins and sparse rows: a pin holds dependents still across regenerates and
  clears when the content changes; a skipped cell costs nothing and blocks
  its dependents with a reason.
- Recipes: a stage column runs after its source column in the same row and
  ignores the row's inputs; a follow-up row under a stage column re-applies
  the stage to the edited base; a template and a literal that render the
  same text share a hash; editing a template reruns only that column and
  its dependents.
