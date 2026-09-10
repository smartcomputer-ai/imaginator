# Imaginator — Core Design

A personal workbench for image (later video) generation models, shaped like a
spreadsheet. A **collection** is a grid: rows are prompts, columns are models,
and every cell is the picture that model made for that prompt. Cells can take
other cells' outputs as inputs, so the grid recalculates the way a sheet does:
change a prompt, regenerate a base image, or pin a different version, and
eligible downstream cells follow. Comparing models side by side, editing an
image in a chain, and piping one model's output through another are all
the same mechanism.

The backend keeps every live collection "filled in" by generating whatever
cells are missing or stale. A UI and an MCP server are two clients of the same
core API. Recalculation can submit paid, asynchronous requests: selected
outputs, execution controls, and visibility into cascades are part of the
core workflow.

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
collection's own definitions are described by one JSON document plus its
frozen assets. An export with cross-collection references also declares its
external dependencies; it is not a self-contained workbook backup.

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
Collection ─┬─ columns[]  (Column: model, settings, count, recipe)
            ├─ rows[]     (Row: prompt, inputs[], common settings, columns?, paused)
            └─ defaults   (common settings applied to every row unless overridden)

Cell (row × column) = column recipe applied to row
        ├─ pin?           (selected successful generation)
        ├─ executionHold? (explicit cancellation for a desired hash)
        └─ generations[]  (attempt history; current = pinned, else newest matching success)
                └─ outputs[] → Asset

Input = frozen Asset | live reference to another cell's current output
Asset (uploaded | generated) = file on disk + thumbnail + dimensions + mime
```

The one structural rule: **a cell never carries its own prompt or inputs.**
Every cell is a column recipe applied to a row. This is where we part from a
spreadsheet, deliberately: comparison columns apply the same row to different
models, and stage columns apply a consistent recipe across rows. The grid is
optimized for comparisons, parallel edit chains, and repeatable pipelines.
Uneven branches and model-specific edits may need sparse rows or another
collection; an arbitrary DAG is not guaranteed to read naturally as a grid.
Everything below is built so that the simple reading,
"rows are prompts, columns are models", stays true until you ask for more:

1. Rows are prompts, columns are models. A column without a recipe is a model.
2. "Follow up" on a cell adds a row that references a source row: one
   image-edit chain per model, side by side. It passes the selected image
   and a new instruction, not a conversation transcript or provider session.
3. "Use as input" can drop a frozen asset or a live reference into a row,
   optionally naming a column or another collection.
4. A column recipe can add inputs, rewrite the prompt, and override common
   settings, which turns the column into a pipeline stage.

### Collection
```ts
{
  slug: 'neon-cats',
  title: 'Neon cats',
  description?: string,
  status: 'live' | 'paused',          // paused = no new provider submissions
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
  common?: CommonSettingsOverride,   // per-key override; null removes an inherited key
  negativePrompt?: string | null,    // absent inherits the row; null removes it
}
```

`count` is how many outputs each cell in the column asks for (default 1,
capped by the model's `capabilities.count`). It lives on the column, not the
row, because it is part of what the column *is*: a column asking for four
samples is a different experiment from one asking for one.

`prompt`, `inputs`, `common`, and `negativePrompt` are the column's
**recipe**: how it builds a cell out of the row. All inherit the row by
default, so a column with no recipe is simply a model. See "Column recipes"
below.

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
  own base, and a chain of edits reads top to bottom per column.
- **`r1/flux` on a row** shares one live base across every model: "film grain" applied
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

The index distinguishes written references from the effective cell edges
after recipe expansion and sparse-row filtering. Scheduling, cycle detection,
and impact previews use the effective graph; integrity checks also retain
written references that a recipe currently ignores. Every structural write,
including adding columns, changing recipes, or changing `row.columns`, checks
the resulting graph in the same transaction. Changing a reference to another
cell with the same asset still updates the index even when the hash stays
the same.

### Column recipes

A column is a model plus a recipe for turning the row into a request. The
recipe inherits the row by default:

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
- **`common`** overrides the row's effective common settings per key. For
  example, an upscale column can set a larger `size`, while a crop stage
  can replace `aspectRatio`. A null value removes an inherited key.
- **`negativePrompt`** inherits when absent, replaces the row's value when
  a string, and removes it when null. A later stage need not inherit a
  negative prompt intended only for the base generator.

A row's `maskFor` indices count within the row's inputs and are shifted by
the number of inputs before the placeholder when the recipe is expanded.
At most one row-inputs placeholder is allowed. Column-authored `maskFor`
indices name an explicit init entry in the column recipe, not an entry
inside the placeholder; expansion remaps those indices too. Validation of
the final list checks the resulting targets and roles.

Reading a row left to right across stage columns is a pipeline. With
columns `flux`, `film` (Kontext, recipe `[flux → init]`, an instruction
template), `upscale` (recipe `[film → init]`) and `baseline` (a text-only
comparison model):

```
          flux         film             upscale           baseline
r1  cat   flux(cat)    film(r1/flux)    upscale(r1/film)  baseline(cat)
r2  ↳r1   flux(edits   film(r2/flux)    upscale(r2/film)  unsupported
            r1/flux)                                    (cannot take init)
```

Flux makes the image, Kontext adds grain to it, the upscaler finishes it,
and the baseline cell is an unrelated comparison. Row r2 is a follow-up on
r1 written the ordinary way: in `flux` it edits r1's Flux image; in `film`
the recipe ignores the row's reference and takes r2/flux, the edited base,
so the grain stage re-applies to the edit. "Stage" is not a concept the
engine knows. A stage is a column whose recipe references another column,
and it waits, runs, and reruns like any cell.

### Settings
Two disjoint vocabularies:

- **CommonSettings** (`aspectRatio`, `size`, `seed`, `outputFormat`): a
  small shared vocabulary, supported selectively by models. Collection
  defaults fill gaps in the row; the column recipe may then override or
  remove individual keys. Resolution, with the rightmost value winning:
  `collection.defaults` ← `row.settings` ← `column.common`.
- **ModelSettings** (`quality`, `style`, `guidance`, `steps`, ...):
  provider-specific knobs declared by the model's zod schema. Owned by the
  **column**; the model's registry defaults fill gaps. Rows cannot set them.

`CommonSettingsOverride` has the same optional keys as `CommonSettings`,
each also accepting null. Null deletes the inherited key before validation
and hashing; it is not sent to the provider. Omission inherits. A recipe
changing aspect ratio must also replace or remove any conflicting inherited
size; neither key silently wins over the other.

Every cell in a column runs the same model configuration and the same
recipe. Plain comparison columns inherit the row settings unchanged; a
stage's overrides are shown in its header/editor and resolved request.
Validation rejects model keys in row settings or `column.common`, and
common keys in `column.settings`. Common overrides belong to the recipe,
not to individual cells.

Each model declares which common keys it honors. An unsupported common key
is dropped at resolution time and the drop is recorded on the generation so
the UI can show "seed ignored by this model". Anything stronger than a
dropped key, such as input images a model cannot take, is never dropped; the
cell becomes `unsupported` instead (§4.1). Invalid values for supported keys
also make the cell `unsupported`. After dropping unsupported keys, a concrete
`size` and `aspectRatio` must agree; neither silently overrides the other.

### Attempts, current output, and display

A cell exposes separate facts; one generation cannot stand for all of them:

| Field | Meaning |
|---|---|
| `desiredHash` | Identity of the currently resolved request; absent while inputs cannot resolve or the cell is skipped. |
| `latestAttempt` | Newest non-cancelled generation with that hash, whether active, successful, or failed. Drives attempt progress and retry controls. |
| `current` | Selected **successful** generation with that hash: an applicable pin, otherwise the success with the greatest version ordinal. Its outputs are available to live references. |
| `display` | `current` when present, otherwise the newest successful generation in the cell's history, marked stale and showing its provenance. Display fallback never supplies a live reference. |

A regenerate starts a new attempt; it does not remove an existing matching
success. Until a new success is selected, dependents continue using the
existing current output. A failed regenerate leaves the working chain
intact and shows an error alongside the image. This also means a dependent
edited during sampling may run against the existing output and rerun after
a new sample succeeds; use a pin to hold the output when exploring.

If content changes and no matching success exists, the old image remains
visible as stale, but dependents block until their inputs resolve. A cell
with a failed latest attempt and a valid current success is usable as an
input; attempt failure and input availability are separate states. Version
ordinals, not completion times, select among successes, so a late completion
cannot replace a newer successful version.

### Pins and execution controls

A **pin** names a successful generation of that cell as current and can be
set only when its hash matches the desired hash. It applies only while that
hash matches. A stored pin becomes inactive if the content changes or inputs
cannot resolve, and applies again if the original hash returns; `unpin` or a
new pin removes or replaces the choice. Inactive pins are visible in the UI.
The resolver never mutates pins or uses a stale pinned image as an input.

Regenerate a base three times, pin #2, and downstream builds on #2;
regenerate more and nothing moves; pin #5 and eligible dependents recalculate.
Unpin selects the newest matching success, even if a later attempt failed.
Pins select a generation's outputs; a reference's `output` index still
selects an image within that generation. Pins live on the source and preserve
per-column references without editing every consumer.

**Pause controls execution.** Pausing a row or collection prevents new
provider submissions there and cancels its queued work. Already submitted
work may finish; its successful output can still become current. A valid
current output remains usable by live dependents, including those in another
collection. If edits made while paused have no matching success, dependents
block on the missing result. Resume schedules only the work still needed.
Explicit regenerate/retry also refuse a paused target.

**Pins control selection.** "Hold current output" pins the current success
while more samples are generated. Regenerate offers `holdCurrent: true`,
which pins the current success and inserts the attempt in one transaction;
it requires a current success and preserves an existing applicable pin.
Choosing a new pin or unpinning releases the new selection downstream. For
experiments that change the source request itself, pause the consuming rows
or collections: pins never override a changed desired hash.

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

For every cell the row runs in whose inputs resolve, the desired request is
identified by `requestHash = hash(content(collection, row, column))`.
Resolution also runs for paused rows and collections so their existing
outputs can be read. Only live collections and non-paused rows may submit
new work.

**The hash covers what the cell asks for, not what the provider receives.**
`content()` is:

- the column's model ID, its `settings` as written, and its `count`;
- the rendered prompt and the negative prompt after recipe overrides;
- the ordered inputs after the column recipe is expanded, with roles and
  mask targets, where every reference is replaced by the asset ID of the
  source cell's current output;
- common settings after collection defaults, row settings, and column
  overrides, with null removals applied and unhonored keys removed.

Registry defaults, dropped-key records, the registry version, and anything
else `resolve()` adds on the way to the provider are **not** hashed. They
are recorded in the generation's `request` snapshot instead. The distinction
is what makes the identity stable: upgrading the server or changing a
model's default `steps` must never invalidate every cell. User edits that
change effective content do change the hash; edits hidden by recipe
overrides do not. Removing unhonored keys before hashing means changing a
seed on a model that ignores seeds also leaves its hash unchanged.

Templates and references are hashed by what they *resolve to*, never as
written. A template that renders to the same text as a literal prompt, and a
reference that resolves to the same asset as a frozen input, are the same
content and do not rerun. This makes recipes and references safe to
refactor, and it is why a cell's hash literally contains the picture it was
made from. Events schedule recalculation; each pass then recomputes hashes
and selection from current data. No event payload decides which image a
dependent consumes.

**Resolution is workbook-wide.** The resolver for a pass is scoped to the
reconciling collection but lazily loads any collection a reference points
into, memoized for the pass, reading inside the same transaction. Resolving
a cell resolves its sources first, recursively, so a chain of any length
resolves in one pass as far as its finished sources allow.

A cell is **satisfied** when it has a generation with the desired hash in
any status other than `cancelled`. This only means no automatic attempt is
needed; it does not imply success or an available output. Otherwise, if the
scope is live and no explicit cancellation hold applies, the reconciler
inserts a generation with that hash and a request snapshot: `queued` if
compatible with the column's model, `unsupported` if not (see below).

A cell with a reference that has no usable current output is **blocked**.
The source may be missing, skipped, awaiting its first matching success, or
failed without a matching success. A missing output index or asset also
blocks with a specific reason. Pausing a source alone does not block its
valid current output; pausing one that needs work prevents that missing
output from becoming available automatically.

A blocked cell has no desired generation, so nothing is inserted. Its
display may still show a stale historical image alongside the blocked reason
("waiting for r3", "r3 failed", "moonbase/r3/flux needs generation but is
paused"). Blocking is transitive and clears on recalculation when sources
become usable, including through cached results and selection changes.
Regenerate and retry refuse a blocked cell. A `skipped` cell is outside the
desired state: no submission and no output available to references, even if
it has successful history.

Several generations can share one hash; they are samples of the same
request. The hash is the identity of *what was asked*; the generation's
`version` ordinal distinguishes the samples. Neither a nonce nor a timestamp
goes into the hash. If it did, reverting a prompt after a regenerate would
produce a hash that matches nothing and run again, which is exactly the
waste the hash exists to avoid.

**Invalidation covers the transitive dependency closure.** Every mutation
that can change a cell's request, selected output, availability, or progress
dirties that cell's collection and all transitive dependent collections.
Triggers include row/column edits, topology changes, pause/resume, pin/unpin,
new attempts, cancellation, and every generation status transition. It is
safe to conservatively schedule a pass when only progress changed; a
satisfying attempt or explicit hold prevents duplicate generation.

The reference index expands the affected closure using both old and new
edges for structural edits. Dirty work is recorded synchronously with event
handling, then passes are debounced ~200ms and coalesced per collection.
Every affected collection is scheduled even if an intermediate collection
needs no generation. For `A → B → C`, reverting A to cached output must
recalculate B and C without waiting for a new success event from B.
Collection-level cycles can exist in an acyclic cell graph, so closure
traversal deduplicates collections and cell resolution follows the cell DAG.

Passes read a coherent transaction snapshot and run again if new events
dirty them. Boot dirties all collections, and recovery transitions invalidate
their dependents too. There is no polling timer. Derived-view notifications
acknowledge the scheduled work; they do not recursively schedule more passes
(§5).

Consequences:
- Edit a row → cells whose effective content changes get new generations,
  then whatever references their new outputs, hop by hop. Other rows are
  untouched unless they depend on those changes.
- Add a column → every row gets one new cell.
- Revert an edit → the old hash already has a succeeded generation, so
  the matching selected success becomes current again. Downstream cells
  reuse their old results when the same asset choices return. Reverting a
  four-hop chain can cost zero generations; the hash alone cannot restore
  a different historical sample selection.
- Set a seed on a model that ignores seeds → no new generation, since the
  key is removed before hashing.
- Pause, edit ten things, resume → one wave for the final desired content
  in the paused scope. Live consumers elsewhere can still react to changes
  that resolve to existing successes; pause those consumers to hold them too.
- Restart → reconcile picks up where it left off.
- Provider changes (API keys, concurrency, even model default settings in
  the registry) are *not* part of the hash, so they never trigger
  regeneration. Only the collection's own content does.
- Regenerate a cell that other cells reference → a successful new sample
  becomes current (unless the cell is pinned), so dependents get new content
  and run again, hop by hop, in whichever collections they live. Only cells
  whose resolved inputs actually changed move: regenerating r1/flux touches
  the Flux column's chain and any stage columns fed by it, leaving independent
  columns untouched. Old generations stay in history with the exact
  base they were made from.
- Pin a version → dependents recalculate against it once; further
  regenerates of the pinned cell change nothing downstream.
- Edit a column's template → only that column and what depends on it rerun.
- Pause a row → it stops submitting work; valid outputs remain usable.
- A regenerate fails → the error is visible, the previous matching success
  remains current, and its working downstream chain remains available.

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
approximated. An edit that changes effective content changes the hash, so
the check runs again for that request. Retry can explicitly recheck an
unsupported attempt after a capability or adapter change.

**Superseded work is cancelled.** When a cell's hash changes, its inputs
become unavailable, or the cell is skipped while old work is in flight:
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

**"Give me another one"**: `cell regenerate` inserts a new generation with
the same hash and `forced: true`. Useful for non-deterministic models.
With a seed set on a model that honors it, a
regenerate legitimately returns the same image; a user who wants variety
clears the seed. Retry applies to the latest failed, unsupported, or
needs-attention attempt, even if a prior success remains current, and can
release an explicit cancellation hold. `cell pin` and `cell unpin` change
selection without changing the source's request hash; dependent hashes change
only when the selected input assets change.

An explicit `cell cancel` also records an execution hold for that cell's
desired hash, so cancellation-triggered reconciliation cannot immediately
recreate the cancelled work. Queued attempts for that hash are cancelled;
submitted attempts follow the remote cancellation rules above.
Regenerate/retry or a different concrete desired hash clears the hold;
pause/resume alone does not. Cancellation for supersession or pause does not
create this user hold. A matching successful output, if
present, stays usable. These controls are cell metadata, never request
content and never part of the hash.

**Cascade visibility ships with live dependencies.** `cells impact` is a
read-only preview of a proposed regenerate, retry, pin, or unpin. It reports
potentially affected cell addresses and collections, the direct/transitive
counts, and existing controls such as paused scopes and applicable source
pins. The UI shows this footprint beside the action and offers "hold current
output" for sampling. Pausing consuming rows or collections holds their
execution without pausing the source.

The preview uses the effective graph and current state. Unknown future
output assets mean it describes potential work, not an exact run count or
price; caches and controls can reduce it, and concurrent edits can change it.
A downstream pin is not automatically a stopping point: changed inputs can
make its hash no longer match. Provider concurrency limits bound simultaneous
work, not total cost. Price estimates and hard budgets can follow later.

### 4.2 The runner

A single in-process loop, one per server:

```
loop:
  pick queued generations, oldest first, where
    provider slots available (per-provider semaphore) and
    global slots available (global semaphore)
  for each: service revalidates eligibility, then marks submitting in the same transaction
            spawn `execute(generation)` (not awaited)
  await "something changed" (new queued row, slot released), then loop
```

`execute` resolves input assets to bytes, calls the provider adapter, stores
outputs as assets, updates the generation, and emits events. It never blocks
the loop; every provider wait is an `await` on `fetch` or `setTimeout`. With
a few dozen in-flight generations the process is idle almost all the time,
since the real work happens at the provider. The runner knows nothing about
references: by the time a generation is queued, its inputs are asset IDs.
The service that claims queued work checks that the request is still desired,
its inputs are usable, and its scope is live and not held. This prevents a
debounced invalidation or pause from letting obsolete queued work submit.
Once marked submitting, remote cancellation follows the lifecycle rules.

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

A `needs_attention` generation holds no runner slot and prevents automatic
retry until `cell retry` inserts a fresh attempt. A prior matching success
can still be current and usable. The UI shows the ambiguous attempt
distinctly from `failed`.

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
collection.created | .updated | .deleted        { collection }
collection.invalidated | .reconciled            { collection }
row.updated | row.deleted                       { collection, row }
column.updated | column.deleted                 { collection, column }
cell.updated                                    { collection, row, column }  // pins and execution holds
generation.updated                              { id, collection, row, column, status }
asset.created                                   { id }
```

Events carry IDs, not document payloads. Consumers refetch a coherent view
of the latest state. The originating write schedules the affected closure
and emits `collection.invalidated` for its collections, including those
whose own rows were not edited. Each completed pass emits
`collection.reconciled`, even if it only restored cached selections or
updated blocked reasons and inserted no generations. These derived events
refresh consumers and advance cursors; they never feed back into invalidation.

Every event also carries a **cursor**: a per-collection counter that
increments on each event, alongside a server boot ID. `collections get` and
every mutation return the collection's current cursor. A client that holds a
cursor can ask "has anything happened since?" without guessing, which is
what `collection wait` below is built on. The cursor is in memory only; a
cursor from a previous boot is treated as stale and any wait on it returns
at once.

Consumers:
- **Reconciler** subscribes to source mutations and generation transitions
  and schedules the transitive closure described in §4.1. It ignores the
  derived invalidated/reconciled events as scheduling inputs.
- **Runner** subscribes to `generation.updated` (status `queued`) to wake up.
- **SSE endpoint** forwards events to browsers, optionally filtered by
  collection. The UI invalidates the matching TanStack Query keys and
  refetches; a grid of a few hundred cells refetches in one request. On
  reconnect the UI simply refetches; there is no replay log, since a refetch
  is the recovery.
- **MCP** uses `collection wait { cursor, timeout }`: return after the
  collection's cursor advances and the currently dirty work affecting its
  view has reconciled, or when the timeout elapses. On timeout, pending
  reconciliation remains visible in the returned progress; it cannot be
  mistaken for settlement. The collection view and wait response expose
  the same dependency-aware progress contract below.

### Collection progress and waiting

Local `queued` and `inFlight` counts remain useful diagnostics, but they
cannot establish that a collection is settled. A collection may have no local jobs while an
upstream collection generates its inputs. Conversely, a superseded remote
attempt may still be monitored without being able to change the desired
results.

`progress` is computed for the collection's included cells and the upstream
work that can affect them, across collections. It answers one question,
"will anything else happen on its own?", and keeps that separate from
"did every cell succeed?":

| State | Meaning |
|---|---|
| `running` | Relevant work is queued, active, runnable, or awaiting reconciliation, locally or in a prerequisite collection. Some branches may already be blocked or failed. |
| `blocked` | Nothing can advance automatically, and at least one included cell is waiting on a *dependency* that cannot become available without intervention: its source has no usable success (failed, unsupported, needs attention), is paused while needing work, was explicitly cancelled, or is skipped. |
| `settled` | Nothing can advance automatically and no included cell is waiting on a dependency. Every cell is either successful or terminal in its own right. |

A cell that is itself `failed`, `unsupported`, or `needs_attention` is
**terminal, not blocked**. Unsupported cells are an expected outcome of a
comparison grid (a text-only column given an init image), and a failed
first attempt is a fact about that cell, not about its dependencies. Such
cells never keep a collection out of `settled`; they appear in the
response's `attention` lists (`failed`, `unsupported`, `needsAttention`,
each with addresses and messages) alongside a separate list of newer failed
attempts on cells that still have an older matching success. "Every desired
output exists" is therefore `settled` with empty attention lists, and the
response says so directly as `allSucceeded`.

Responses also include `pendingReconcile`, upstream queued/in-flight counts,
and structured blocking reasons with source addresses. Work behind an
applicable pin that cannot change the selected output does not keep its
consumers running. Non-superseded attempts for included cells in the
requested collection itself count as running even under a pin: those
samples are local work the user requested. Superseded attempts remain
visible in diagnostic counts without delaying settlement.

An agent's loop is "mutate (get cursor) → wait(cursor) → inspect, repeat
while progress is running". On `blocked`, report or address the listed
sources; do not wait forever for an event that needs user intervention. On
`settled`, read the attention lists: empty means every desired output is
available; otherwise the grid is as done as it will get and the listed
cells need a retry, a row change, or acceptance. Dependency-only changes
wake a waiter and refresh a collection-filtered SSE client even when the
requested collection has no generation event of its own. Counts and
progress are read from one coherent snapshot after the relevant passes,
rather than inferred from the last event's payload.

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
| cells | `get` (current, latest attempt, display, versions, precedents and dependents), `impact`, `regenerate` (optional hold-current), `retry` (failed, unsupported, needs_attention attempt or explicit cancellation hold), `cancel`, `pin`, `unpin` |
| generations | `get` (full request snapshot, error, timing) |
| assets | `upload`, `get`, `list`, `label`, `gc` |
| events | `stream` (HTTP only) |

`collections get` is the document an LLM works from: rows with prompts and
inputs, columns with models and recipes, and for each cell the desired hash,
current successful output, latest-attempt status/error, display provenance
and stale marker, pin state, execution hold, version count, and blocked
reason when present. Asset IDs and thumbnail URLs identify the images.
The document includes the dependency-aware progress from §5 and stays compact
enough for an agent working with a normal-sized collection.

Design rules for the command layer:
- Accept readable addresses everywhere: `neon-cats/r3/flux-pro`,
  `neon-cats/r3/flux-pro#2`, plain asset IDs. References are accepted both
  as objects (`{ row, column, collection, output, role }`) and as partial
  address strings (`r3`, `r3/flux`, `moonbase/r3/flux`), normalized to the
  object form.
- Mutations return the updated object and the collection's cursor; no
  separate refetch needed.
- `cells impact` accepts the proposed action and selection, uses the same
  resolver and dependency graph as execution, and returns its read-only
  footprint with observed collection cursors. It is a preview, not a
  reservation or approval gate; execution validates against current state.
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
  `regenerate_cell`/`retry_cell`/`cancel_cell`/`pin_cell`/`unpin_cell`,
  `preview_cell_impact`, and `upload_asset`. UI-only commands (reorder, rename, duplicate,
  import/export, labels, gc) are HTTP only. Pause/resume fold into
  `update_collection { status }` and `update_row { paused }`. Tool
  descriptions explain reference addresses, recipe inheritance, successful
  selection versus latest attempts, pin versus pause, and the progress
  states. Agents get the same cascade preview and hold-current option as
  the UI.
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
  and returns dependency-aware progress, emitting `notifications/progress`
  when requested. The workflow does not depend on resource subscriptions
  or MCP tasks.

The client behaviour these choices rest on (which clients show the model
tool-result images, who reads resources, size limits, protocol eras) is
written up with sources in `docs/MCP-CLIENTS.md`.

---

## 7. UI shape

Routes:
- `/` collections list with execution status, cell counts, and progress,
  including waiting on another collection or blocked on an intervention.
- `/c/:slug` the grid. Row header = prompt (inline editable), inputs as
  thumbnails (a reference shows as an address chip, `↳ r3`), settings
  popover, pause toggle, "add follow-up row". Column header = model,
  settings popover, and a `← flux` marker when the column's recipe
  references another column, plus explicit common-setting overrides.
  Cell = current image with attempt progress/error, or a stale historical
  image with the missing/blocked reason, or an empty/skipped cell. Pins and
  execution holds are visible; click for detail. Collection header =
  live/paused toggle, defaults, add column (model picker driven by the
  registry), add row.
- `/c/:slug/:row/:col` cell detail: large view with a fullscreen mode that
  keeps arrow-key navigation between cells, version strip distinguishing
  current output and latest attempt, pin/unpin, the resolved request, error
  or blocked reason, regenerate with "hold current output", "follow up", "use
  as input" (frozen asset, or a live reference with optional column and
  collection), and the cell's precedents and dependents as links. Generation
  and selection actions show the potential cascade footprint, including
  affected collections, and link to the consuming rows' pause controls.
- `/assets` library: uploads and generated, filter, label, drag onto rows.

The features layer so the basics stay untouched. Rows are prompts and
columns are models; nothing else is visible until asked for. "Follow up" on
a cell is the first reference anyone meets. "Use as input" is where absolute
and cross-collection references appear, next to the frozen asset. The
column editor keeps the recipe in a collapsed section showing `{prompt}` and
a single "row inputs" chip, inherited common settings, and an inherited
negative prompt. Adding a column reference makes a stage. Overrides become
visible once set; ordinary comparison columns keep the simple editor. Pause
is labeled as stopping new submissions, and a pin as holding the selected
output, so those controls do not imply the same effect.

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
- Video: `Asset.kind` and `ModelSpec.kind` reserve the distinction. Video
  still needs request capabilities, duration/frame metadata, input
  validation, adapters, storage limits, and playback.
- Cost estimates, accounting beyond the per-generation number, and hard
  execution budgets. Dependency footprints and sampling controls ship with
  references rather than waiting for accurate pricing.
- "Paste values": turn a reference into the asset it currently resolves to.
- Dependency highlighting in the grid (precedents and dependents on hover).
- Multi-process runner (lease column, see §4.2).
- Variable expansion across rows (`{name}` bound per row). Column templates
  cover the pipeline case; row-level variables may be an agent's job via
  MCP.
- Cells whose output is text rather than an image: a prompt-writing model as
  a column, referenced by another cell as its prompt. This requires typed
  outputs, references into prompt fields, conversion/validation rules, and
  request hashing for those values. The current image-input reference model
  does not provide it merely by adding an asset kind and renderer.
- Native conversational generation: retaining message history or provider
  session state requires an explicit context model and immutable context
  snapshots. Image-edit chains do not promise that behavior.
- Self-contained workbook export/import, including dependency closure,
  generation history, selected versions, and asset files. The initial
  collection export declares external references and requires them to exist
  on import.
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
7. **Selection and execution contracts, pins, and sparse rows.** Separate
   latest attempt, current success, and display fallback; specify pause and
   explicit cancellation holds; revalidate queued submissions. Add pin/unpin
   with hash-scoped applicability, atomic hold-current sampling, `row.columns`,
   and skipped cells. Cover every relevant transition in local invalidation,
   expose dependency-aware progress, and ship cascade previews and controls
   for the existing same-column chains.
8. **Same-collection recipes and references.** Column anchors on row
   references, partial-address parsing, and column recipes with prompt/input
   expansion, common overrides, and negative-prompt inheritance. Maintain the
   reference index and effective cell graph, validate cycles and deletion,
   and extend impact previews to stages. Add the recipe editor, stage and
   override markers, and precedent/dependent links.
9. **Cross-collection references.** Full addresses, a workbook resolver,
   transitive invalidation using old/new edges, dependent collection cursors
   and SSE, and waiting across prerequisites. Add cross-collection cycle
   checks, delete refusal, rename rewriting, explicit export dependencies,
   and cross-collection impact previews before enabling live external links.

Steps 1 to 6 have an initial implementation. Step 7 changes its latest-attempt
selection behavior and completes the execution and progress contracts above;
these are target semantics, not claims that all are already implemented.
Each remaining step is usable on its own. Pins and local pipelines precede
the global dependency-management work.

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
  follow-up is blocked while its base has no usable success and fills once
  one becomes available; a queued follow-up is superseded when its base
  changes mid-flight; reference validation (unknown, self, cycle, removal
  of a referenced row); an absolute reference feeds the same picture to
  every column; an external reference follows selected successes across
  collections; a cross-collection cell cycle is refused; an acyclic cell
  graph with collection-level cycles resolves and invalidates without loops;
  renaming keeps references working; restoring the same selected assets
  finds the old downstream chain with no runs; an asset-equivalent reference
  rewrite updates dependency tracking without generating.
- Selection: a failed regenerate preserves a previous matching success and
  its downstream chain while exposing the attempt error; changed content
  shows a stale image without exposing it as a live input; late completion
  cannot replace a newer success; retry targets the failed latest attempt
  even when a successful output is current.
- Pins and sparse rows: only matching successes can be pinned; a pin holds
  dependents still across regenerates; it becomes inactive on a different or
  unresolved hash and applies again on revert; unpin selects the newest
  matching success despite a later failed attempt; hold-current and attempt
  insertion are atomic; a skipped cell costs nothing and blocks its
  dependents despite historical outputs.
- Execution controls: pausing an already successful source preserves usable
  outputs; editing it while paused blocks dependents only when no matching
  success exists; pausing consumers stops their queued work while the source
  remains live; submitted work can finish after pause; explicit cancellation
  is not automatically recreated on invalidation or restart; retry releases
  the cancellation hold; a queued claim cannot submit after a pause, skip,
  hold, or upstream edit made before its claim transaction.
- Invalidation and waiting: an A → B → C revert across collections restores
  cached results without any new success events; pause/resume, pin/unpin,
  failure, cancellation, and restart recovery reach all affected views;
  derived notifications do not form an event loop; SSE filtered to a
  dependent collection and its cursor waiter observe upstream-only changes;
  zero local jobs with an active upstream reports running; an upstream
  failure without usable output reports blocked with that source listed; a
  plain failed or unsupported cell with no dependents reports settled with
  the cell in the attention lists, never blocked; a successful cached
  closure reports settled with empty attention lists and `allSucceeded`;
  sampling a pinned source keeps its own collection running without keeping
  an external consumer running; a timeout during reconciliation never
  reports settled; unrelated or superseded remote work does not delay
  settlement.
- Recipes: a stage column runs after its source column in the same row and
  ignores the row's inputs; a follow-up row under a stage column re-applies
  the stage to the edited base; a template and a literal that render the
  same text share a hash; editing a template reruns only that column and
  its dependents; common overrides follow precedence and null removal;
  conflicting inherited size/aspect ratio is rejected without approximation;
  negative-prompt removal reaches the request; row and column mask targets
  remap correctly; adding a column or changing a sparse row/recipe cannot
  introduce a cycle through previously inactive references.
- Cascade previews: effective dependencies exclude discarded row inputs;
  affected collections and paused scopes are shown; source hold-current
  sampling has no selection cascade; a dependent pin invalidated by changed
  inputs is not mistaken for a propagation barrier; previews make no writes
  or provider calls and label unknown output effects as potential work.
