# Imaginator

**Run image generation experiments across different models and providers.**

**Work in a grid: prompts are rows, models are columns.** Think, "Excel for image prompts". Any changes to a row or column immediately regenerates the relevant cells in parallel.

Designed to be used by agents via an MCP backend for rapid experimentation. 

![Imaginator grid](docs/images/screenshot-1.jpg)


## Quick start

```sh
corepack enable            # pnpm via corepack
pnpm install
cp .env.example .env       # then add your provider API keys
pnpm dev                   # server on :4747, web on :5173
```

Open http://localhost:5173.

Providers are enabled by the keys in `.env` (`OPENAI_API_KEY`, `FAL_KEY`,
`BFL_API_KEY`, `GOOGLE_API_KEY`, `REPLICATE_API_TOKEN`). To try it without
spending anything, leave the keys empty or set `IMAGINATOR_MOCK=1`: the
`mock/*` models render prompts onto colored images and exercise the whole
workflow.

## Connect an agent (MCP)

The server hosts an MCP endpoint at `http://127.0.0.1:4747/mcp` (Streamable
HTTP, both the 2026-07-28 and the 2025-era protocol). Claude Code:

```sh
claude mcp add --transport http imaginator http://127.0.0.1:4747/mcp
```

Clients that only launch local stdio servers (Claude Desktop, most config
files) use the bridge, which forwards to the running server:

```json
{ "mcpServers": { "imaginator": { "command": "pnpm", "args": ["--dir", "/path/to/imaginator", "mcp"] } } }
```

The agent gets tools to create collections, add rows and columns, wait for
generations, and look at the results as images. Try the `compare-models`
prompt: give it a few prompts and it sets up the grid, waits, and writes a
comparison. Details, including what different MCP clients can and cannot do
with images, are in `packages/server/README.md` and `docs/MCP-CLIENTS.md`.

## Authenticated mode

By default the server is an open localhost tool. To expose it, set in `.env`:

```sh
AUTH_ENABLED=1
AUTH_PASSWORD=...        # web UI login
AUTH_API_KEY=...         # MCP clients and scripts: Authorization: Bearer <key>
IMAGINATOR_HOST=0.0.0.0  # optional: listen on all interfaces
```

The web app then shows a login page and keeps a session cookie (30 days,
`AUTH_SESSION_DAYS` to change). MCP and `/api` calls need the bearer key:

```sh
claude mcp add --transport http imaginator http://host:4747/mcp --header "Authorization: Bearer $AUTH_API_KEY"
curl -H "Authorization: Bearer $AUTH_API_KEY" http://host:4747/api/collections.list
```

The stdio bridge (`pnpm mcp`) picks `AUTH_API_KEY` up from the environment or
`.env` on its own. Only `/api/health`, the login routes and the static web app
stay open. Put TLS in front (a reverse proxy) when the host is not on a trusted
network; the cookie is marked `Secure` when the request arrives over HTTPS or
with `X-Forwarded-Proto: https`.

## How it works

- **Nothing is imperative.** You never press "generate". Adding a row or a
  column to a live collection is the request; the server fills every cell that
  is missing and leaves alone every cell whose content did not change.
- **Edits are cheap and precise.** Change one prompt and only that row
  regenerates. Change a column's model settings and only that column does.
  Revert an edit and the earlier result comes back without a new run, because
  results are keyed by what was asked, not by when.
- **Rows own the prompt, columns own the model.** Rows carry the prompt,
  optional input images (reference, init, mask) and common settings such as
  aspect ratio or seed. Columns carry the model and its provider-specific
  settings. That split keeps every cell in a column comparable.
- **Pause to plan, resume to run.** A paused collection can be edited freely;
  resuming runs one wave of generations for everything that is missing.
- **History is kept.** Every generation stays as a version of its cell.
  "Regenerate" asks the same request for another sample; "retry" re-runs a
  failed one. Failed cells never retry on their own, so a broken prompt cannot
  burn money.
- **Assets are shared.** Uploaded images and generated outputs live in one
  library and can be used as inputs in any row of any collection.

## Development

```sh
pnpm typecheck        # all packages
pnpm test             # all packages
pnpm dev:server       # server only (tsx watch)
pnpm dev:web          # web only
pnpm mcp              # stdio bridge to the running server's MCP endpoint (/mcp)
```

| Package | What |
|---|---|
| `packages/core` | Domain types, zod schemas, IDs and addresses, request resolution and hashing, `Provider` interface, command IO schemas. Browser-safe, no I/O. |
| `packages/server` | SQLite persistence, asset store, services and event bus, reconciler, runner, provider adapters, HTTP + SSE, MCP. |
| `packages/web` | Vite + React grid UI. |

Every operation is also a plain `POST /api/<command>` with a JSON body;
`GET /api` lists them all with their schemas.

## License

Apache 2.0, see [LICENSE](LICENSE).
