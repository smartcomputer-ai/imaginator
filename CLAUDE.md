# Imaginator

Personal workbench for comparing image generation models. Read `docs/DESIGN.md`
first; it is the source of truth for the domain model, the declarative
generation engine, and the command registry.

## Layout

- `packages/core` — types, zod schemas, IDs/addresses, `resolveCell()` + hash,
  `Provider`/`ModelSpec` interfaces, `ModelRegistry`, command IO schemas
  (`commandDefs`). No I/O, no Node built-ins (browser-safe). Exported from `src/`
  directly; no build step.
- `packages/server` — SQLite (better-sqlite3), asset store, services + event
  bus, reconciler, runner, providers (`mock` first), Hono HTTP + SSE, MCP.
- `packages/web` — Vite + React + Tailwind UI.
- `data/` — runtime data (gitignored): `imaginator.db`, `assets/`, `tmp/`.

## Conventions

- pnpm workspaces, Node 22+, TypeScript strict, ESM (`"type": "module"`,
  relative imports end in `.js`). zod v4.
- `pnpm typecheck` and `pnpm test` from the root must pass. Run
  `pnpm --filter @imaginator/<pkg> test` for one package.
- Commands: every API operation is a `CommandDef` in core
  (`packages/core/src/commands.ts`); the server attaches `run`. HTTP is
  `POST /api/<command name>` with a JSON body and JSON response; errors are
  `{ error: { message, code, issues? } }` with 400/404/409/500. SSE at
  `GET /api/events?collection=<slug>`; assets at `GET /assets/:id` and
  `GET /assets/:id/thumb`. Server default port 4747; the web dev server proxies
  `/api` and `/assets` to it.
- Readable addresses everywhere an ID is expected: `coll/r3/flux-pro`,
  `coll/r3/flux-pro#2`, plain 6-char asset/generation IDs.
- Nothing writes to the DB outside a service function; services run one
  transaction then emit events after commit.
- Never hash anything `resolve()` adds (registry defaults, dropped keys,
  registry version). See DESIGN §4.1.
