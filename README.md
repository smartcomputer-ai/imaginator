# Imaginator

A personal workbench for comparing image generation models. A **collection**
is a grid: rows are prompts (plus input images and settings), columns are
models. The server keeps every live collection filled in by generating whatever
cells are missing or stale. A web UI and an MCP server are two clients of the
same command API.

Design: [docs/DESIGN.md](docs/DESIGN.md).

## Quick start

```sh
corepack enable            # pnpm via corepack
pnpm install
cp .env.example .env       # add provider keys; the mock provider works without any
pnpm dev                   # server on :4747, web on :5173
```

Open http://localhost:5173. With no provider keys set, the `mock/*` models are
available and render prompts onto colored images, so the whole workflow can be
tried without spending anything.

## Packages

| Package | What |
|---|---|
| `packages/core` | Domain types, zod schemas, IDs and addresses, `resolveCell()` + request hashing, `Provider` interface, command IO schemas. Browser-safe, no I/O. |
| `packages/server` | SQLite persistence, asset store, services and event bus, reconciler, runner, provider adapters, HTTP + SSE, MCP. |
| `packages/web` | Vite + React grid UI. |

## Scripts

```sh
pnpm typecheck        # all packages
pnpm test             # all packages
pnpm dev:server       # server only (tsx watch)
pnpm dev:web          # web only
pnpm mcp              # stdio bridge to the running server's MCP endpoint (/mcp)
```

## API in one minute

Every operation is `POST /api/<command>` with a JSON body. See
`packages/core/src/commands.ts` for the full registry, or
`packages/server/README.md` for a curl walkthrough.

```sh
curl -s localhost:4747/api/collections.create -H 'content-type: application/json' -d '{
  "slug": "neon-cats",
  "columns": [{ "model": "mock/fast" }, { "model": "mock/slow", "count": 2 }],
  "rows": [{ "prompt": "a neon cat on a rooftop" }, { "prompt": "a neon cat in the rain" }]
}'
curl -s localhost:4747/api/collections.get -H 'content-type: application/json' -d '{"collection":"neon-cats"}'
```
