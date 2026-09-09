# @imaginator/web

Browser UI for Imaginator: Vite + React 19 + TypeScript + Tailwind v4, with
shadcn-style components over Radix primitives, TanStack Query v5 for data,
and react-router v7.

## Running

```sh
# from the repo root
pnpm install
IMAGINATOR_MOCK=1 pnpm --filter @imaginator/server start   # API on :4747
pnpm --filter @imaginator/web dev                          # UI on :5173
```

Open http://localhost:5173. The Vite dev server proxies `/api` and `/assets`
to `http://localhost:4747` (override with `IMAGINATOR_SERVER_URL`), so the
browser only ever talks to one origin. The proxy is configured for SSE:
no timeouts and no buffering on `text/event-stream` responses.

Scripts: `dev`, `build` (`tsc --noEmit && vite build` → `dist/`),
`typecheck`, `preview` (serves `dist/` with the same proxy).

Path rule: `/assets` (no id) is the asset library page and belongs to the
SPA; only `/assets/<id>` and `/assets/<id>/thumb` are proxied to the server.
For the same reason the build writes chunks to `dist/static/`, not the Vite
default `dist/assets/`, so a server that serves `dist/` never has its
`/assets/:id` route shadowed.

## Routes

| Route | Page |
|---|---|
| `/` | Collections list: status, rows × columns, cell counts; create / import / delete |
| `/c/:slug` | The grid. Sticky header (title, live/paused, defaults, add column/row, export/import). Column headers with model settings; row headers with prompt, negative prompt, inputs, common settings, pause, notes. Cells show the current image or a status badge; hover for regenerate / retry / cancel |
| `/c/:slug/:row/:col` | Cell detail: large image(s), version strip, resolved request, error, timing, cost, "use as input", download |
| `/assets` | Asset library: filter by origin/label, inline labels, upload (button, drop zone), copy id, "Add to row…" |

## How the client works

### Typed RPC — `src/api/client.ts`

Every command in `@imaginator/core`'s `commandDefs` is reachable as

```ts
call('collections.get', { collection: 'neon-cats' }) // Promise<CollectionView>
```

`call<N>(name, input)` POSTs JSON to `/api/<name>` and returns the parsed
JSON typed as `CommandOutput<N>`. In dev the response is additionally checked
against the command's zod output schema and a console warning is logged on
drift (the UI keeps working). Non-2xx responses become `ApiError` with
`status`, `code`, and the server's `issues`.

### Queries and mutations — `src/api/queries.ts`

Query keys:

| Key | Command |
|---|---|
| `['collections']` | `collections.list` |
| `['collection', slug]` | `collections.get` — the one query the whole grid renders from |
| `['cell', address]` | `cells.get` |
| `['generation', ref]` | `generations.get` |
| `['assets', filters]` | `assets.list` |
| `['models']` | `models.list` (5 min stale time) |

`useCommand(name)` wraps a command in a `useMutation`. After success it
updates the cache:

- outputs that are a whole `CollectionView` (create/update/pause/resume/
  duplicate/rename/import) are written straight into `['collection', slug]`
  with `setQueryData`;
- row/column/cell commands invalidate `['collection', slug]`, the list, and
  any `cell`/`generation` queries under that slug;
- asset commands invalidate `['assets', *]`.

Errors surface as toasts (sonner) unless `silent: true`. `useApi()` is the
imperative equivalent for drop/paste handlers.

### Live updates — `src/api/events.ts`

`useEvents(slug?)` opens an `EventSource` on
`/api/events?collection=<slug>` (or `/api/events` for the list and assets
pages) for the lifetime of the page. Events are named SSE events
(`event: generation.updated`, `data: {...ImaginatorEvent}`); the payload
carries IDs only. On any event for a collection the collection query (and
its cells/generations) is invalidated; `asset.created` invalidates assets.
Invalidations are debounced 100 ms so a burst of `generation.updated` events
causes one refetch, not fifty. The browser reconnects on its own; when the
stream reopens after an error every active query is refetched, since a
refetch is the recovery (DESIGN §5). The header dot shows the connection
state.

### Editing

Inline editors (`InlineTextarea`) commit once: on blur or Enter
(Shift+Enter inserts a newline), Escape reverts. Settings popovers keep a
local draft and send one `update` on Save. Uploads go through
`assets.upload` with base64 `bytes` (JSON), so paste/drop onto a row header,
the asset picker, and the library all share `useUploadFiles()`.

## Layout of `src/`

```
api/         client.ts (RPC), queries.ts (keys, hooks, cache policy), events.ts (SSE), upload.ts
components/  Layout, StatusBadge, SettingsForm (JSON-Schema → form), CommonSettingsForm,
             InlineEdit, AssetPicker, AddToRowDialog, ui/ (button, input, dialog, popover, …)
features/grid/  GridHeader, ColumnHeader, RowHeader, GridCell, AddColumnDialog, AddRowDialog
pages/       CollectionsPage, GridPage, CellPage, AssetsPage
```
