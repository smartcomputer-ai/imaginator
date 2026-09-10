# MCP clients: what they actually support

Research snapshot from 2026-09-10, gathered while designing Imaginator's MCP
server (DESIGN §6.1). It answers the questions that decide how an
image-producing server should behave: which clients let the model see images
from tool results, what resources are good for, which protocol revision
clients speak, and how big a result can be. Legend: **V** = documented or
verified with a source, **U** = unclear or not found. Things move fast; re-check
the sources before relying on a specific cell.

## 1. Spec and SDK state

**Protocol.** The current revision is **2026-07-28** (earlier: 2025-11-25,
2025-06-18, 2025-03-26, 2024-11-05). Changes a server author must know:

- Stateless core: no `initialize`/`initialized` handshake and no
  `Mcp-Session-Id`; every request carries `_meta` with
  `io.modelcontextprotocol/protocolVersion`, `clientCapabilities`,
  `clientInfo`. New `server/discover` RPC. Clients may still use the 2025-era
  handshake with older servers.
- Results carry `resultType: "complete" | "input_required"`; missing means
  complete. Multi-round-trip requests (MRTR) replace server-initiated
  elicitation, sampling and roots: a tool returns `input_required` and the
  client retries with the answers.
- `resources/subscribe`/`unsubscribe` and the standalone HTTP GET stream are
  replaced by `subscriptions/listen` (opt in to `toolsListChanged`,
  `resourcesListChanged`, `resourceSubscriptions`, ...).
  `notifications/resources/updated` still exists. SSE resumability
  (`Last-Event-ID`) is gone.
- List and read results carry `ttlMs` and `cacheScope`. Resource-not-found
  changed from `-32002` to `-32602`.
- Tasks moved out of core into the `io.modelcontextprotocol/tasks` extension.
- Deprecated with a 12-month window: roots, sampling, logging, HTTP+SSE
  transport, dynamic client registration (in favour of CIMD).
- Content types unchanged: `text`, `image` (base64 `data` + `mimeType`),
  `audio`, `resource_link`, embedded `resource`. `structuredContent` may be any
  JSON value. A tool returning `structuredContent` should also return it
  serialized in a text block.

**TypeScript SDK.** `@modelcontextprotocol/sdk` 1.30.0 (2026-07-27) is the
last 1.x and tops out at 2025-11-25. v2 is a package split, all 2.0.0
(2026-07-27): `@modelcontextprotocol/server`, `/client`, `/core`, `/node`,
`/express`, `/hono`, `/fastify`; Node >= 20, zod >= 4.2 (any Standard Schema
works). API changes: `import { McpServer, ResourceTemplate, createMcpHandler }
from '@modelcontextprotocol/server'`, `serveStdio` under `/stdio`; raw zod
shapes for `inputSchema` are deprecated (wrap in `z.object`);
`createMcpHandler(factory)` is stateless per request and serves 2025-era
traffic in `legacy: 'stateless'` mode (GET/DELETE answer 405) or rejects it
with `legacy: 'reject'`; route with `isLegacyRequest()` to keep a sessionful
2025 path next to it. Handler context is `ctx` (`ctx.mcpReq.signal`, `_meta`,
`notify()`, `send()`), `setRequestHandler('tools/call', ...)` takes method
strings, errors are `ProtocolError`/`SdkError`/`SdkHttpError`. The v2 client
defaults to the 2025-era protocol (`versionNegotiation.mode: 'legacy'`); use
`'auto'` or `{ pin: '2026-07-28' }` for the modern era. Codemod:
`npx @modelcontextprotocol/codemod@latest v1-to-v2 .`

**Adoption.** SDKs (TS v2, Python, Go, C#) ship 2026-07-28. Anthropic said
client support was "rolling out soon"; canimcp.dev listed Claude.ai, ChatGPT,
Cursor and Cline at 2025-06-18 and VS Code at 2025-11-25. Serve both eras.

## 2. Per-client matrix

| Client | Model sees tool `image` blocks | Resources | `resource_link` / embedded | `structuredContent` / `outputSchema` | Prompts | Elicitation | Sampling | Tasks ext. | Transport |
|---|---|---|---|---|---|---|---|---|---|
| **Claude.ai web / Desktop** | **V yes**. Docs list "text and image-based tool results". The UI collapses the image behind an expander; the model still sees it. | V list/read, text **and blob** resources; **no** `resources/subscribe` | U | U | V | U | **V no** | U ("rolling out soon") | Streamable HTTP + legacy SSE (remote); stdio via Desktop config |
| **Claude Code** | **V yes**, but metered: image results count against `MAX_MCP_OUTPUT_TOKENS` (default 25k, warning at 10k) as raw base64 text; `anthropic/maxResultSizeChars` does not apply to images; oversized image results are rejected rather than spilled to a file | V `@server:scheme://path` mentions, auto-fetched as attachments; also list/read tools | U | U | V `/mcp__server__prompt args` | **V form + URL** | U | U (its own 2-minute auto-background is not the tasks extension) | stdio, HTTP, SSE (deprecated), WebSocket; OAuth + CIMD |
| **ChatGPT** (developer mode / connectors) | **V no**. Image blocks come back as `{}`; OpenAI support: connector output is not "a guaranteed model-visible vision input path" | U (docs mention only tools) | U | **V required style**: return `structuredContent` and the same JSON as text; declare `outputSchema` | U | U | U | **V no** (open feature request) | Streamable HTTP or SSE only, no stdio; OAuth (CIMD/DCR) or no auth. `search`/`fetch` tools are only required for deep research and company knowledge |
| **Codex CLI** | **V yes**, converted to input images (token overcount bug fixed) | U | U | Partial: open bug drops `content[]` (including images) when `structuredContent` is present | U | **V form** (merged 2026-04-08) | U | U | stdio + Streamable HTTP; OAuth; per-tool `output_token_limit`, `tool_timeout_sec` default 60s |
| **Cursor** | **V yes**, base64 `type: "image"` | V list/read | U | U | V | **V form** | **V no** | U | stdio, SSE, Streamable HTTP; OAuth; MCP Apps |
| **VS Code Copilot** | **V yes** (since v1.100, April 2025) | V list/read, **templates**, **subscribe / real-time updates**, "Add Context > MCP Resources" | U | U | V slash commands with args | **V form + URL** | **V yes** | U | stdio, Streamable HTTP, SSE; OAuth 2.1 + CIMD; MCP Apps |
| **Windsurf / Devin (Cascade)** | U | V tools, resources, prompts | U | U | V | U | U | U | stdio, Streamable HTTP, SSE; OAuth; 100-tool cap |
| **OpenClaw** | U (no doc; image-bearing tool results exist for its browser tool, not MCP) | V generated `resources_list` / `resources_read` tools | U | U | V `prompts_list` / `prompts_get` | U | U | U | stdio, SSE/HTTP, Streamable HTTP; OAuth (`openclaw mcp login`) |
| **Hermes Agent** | **Partial (V)**: since v2026.5.7 image blocks are decoded, cached and returned as `MEDIA:<path>` tags so messaging adapters render them; whether the LLM gets them as vision input is U | V `list_resources` / `read_resource` tools | U | U | V `list_prompts` / `get_prompt` | **V form** | **V yes** | U | stdio + HTTP (OAuth 2.1, mTLS) |
| **Gemini CLI** | **V yes**: text, images, audio, resource and `resource_link` blocks are packaged for the model | V `@server://resource` (v0.21), resource tools (v0.40, 2026-04-28) | **V** | U | V slash commands | **V no** ("Method not found", deferred) | U | U | stdio, SSE, Streamable HTTP; OAuth |
| **Goose** | U (Rust rmcp client; likely, unverified) | V list/read | U | U | V | **V form** (5-minute timeout) | **V yes** (auto-enabled) | U | stdio, Streamable HTTP; OAuth; MCP Apps |
| **Zed** | **V yes** (fixed in 2025) | **V no** (docs: tools and prompts only) | U | U | V | **V no** | **V no** | U | stdio + remote HTTP |
| **Cline** | **V yes** since v3.13.0 | V list/read | U | U | U | **V no** (still unimplemented April 2026) | **V no** | U | stdio, Streamable HTTP, SSE |

Cross-cutting facts:

- **Resources are application-driven by spec.** No client feeds a server's
  resources to the model on its own. Every client exposes them through user
  `@` mentions or "Add Context" pickers, or through generated list/read tools
  the model can call (Claude Code, Hermes, OpenClaw, Gemini CLI). Only VS Code
  documents `resources/subscribe`; Claude explicitly does not. Only Claude
  ("binary resources") and VS Code ("text and binary content") document
  rendering blob resources.
- **Tasks**: no client documents support; the official extension client matrix
  has no tasks column. Treat as unsupported.
- **MCP Apps** (`io.modelcontextprotocol/ui`) is the supported way to show
  rich visuals inline to the user in Claude, ChatGPT, VS Code, Cursor, Goose.
  Tool-result images are for the model, not the user.

## 3. Size limits

| Client | Limit |
|---|---|
| Claude.ai / Desktop | Tool result about 150,000 characters; 300 s timeout. Community testing: images under ~1 MB render, 5 MB fails. |
| Claude Code | `MAX_MCP_OUTPUT_TOKENS` default 25,000 (warning at 10,000). Images are counted as raw base64 text (issue closed as not planned). A screenshot tool returning 137k "tokens" of base64 was rejected. |
| Claude vision (API) | Standard tier downsizes to 1568 px long edge; token cost roughly (w x h) / 750. 10 MB per image, 20 images per message on claude.ai. |
| Codex CLI | Per-tool `output_token_limit`; default 60 s tool timeout. |

Measured on a noisy 1024 px test image (real generated images compress two to
four times better):

| Encoding | Bytes | Base64 chars | "Tokens" if counted as text |
|---|---|---|---|
| 800 px webp q85 | 206 KB | 275k | ~69k |
| 640 px webp q80 | 96 KB | 128k | ~32k |
| 512 px webp q72 | ~40 KB | ~53k | ~13k |
| 384 px webp q75 | 14 KB | 19k | ~5k |

## 4. Guidance that follows

- **Always pair an image block with a text block** and put ids, dimensions and
  a URL in `structuredContent`. That is the spec's own pattern, what OpenAI
  support recommended for ChatGPT (which drops images), and what people do in
  the claude.ai issue threads. A label before each image is also the only way
  a model can tell which image is which.
- **Downscale before base64.** A 512 px webp is the safe inline default; offer
  larger sizes on request and full resolution through a resource or URL.
- **Prefer `resource_link` / URLs for full-size assets** but do not depend on
  them: support is only documented for Gemini CLI. Put the plain URL in text
  too.
- **Use `structuredContent` + `outputSchema`** but keep the `content[]` blocks
  (Codex bug aside).
- **Expect images to reach the model but not the user** in claude.ai/Desktop.
- **Long-running work**: long-poll with a cursor and send
  `notifications/progress`; do not rely on tasks or resource subscriptions.
- **Transport**: Streamable HTTP for everything remote, plus a stdio bridge for
  clients configured from a file. ChatGPT needs HTTP and, for anything beyond
  localhost, OAuth.

Imaginator's server follows this: see `packages/server/README.md` ("MCP") and
DESIGN §6.1.

## 5. Sources

Spec and SDK
- https://modelcontextprotocol.io/specification/versioning
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- https://modelcontextprotocol.io/specification/2026-07-28/server/resources
- https://modelcontextprotocol.io/extensions/tasks/overview
- https://modelcontextprotocol.io/extensions/client-matrix
- https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://ts.sdk.modelcontextprotocol.io/v2/
- https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md
- https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1204

Claude
- https://claude.com/docs/connectors/building
- https://code.claude.com/docs/en/mcp
- https://claude.com/blog/bringing-mcp-2026-07-28-to-claude
- https://platform.claude.com/docs/en/build-with-claude/vision
- https://github.com/anthropics/claude-ai-mcp/issues/238
- https://github.com/anthropics/claude-code/issues/31208
- https://github.com/anthropics/claude-code/issues/9152
- https://github.com/anthropics/claude-code/issues/53256

OpenAI
- https://developers.openai.com/api/docs/mcp/
- https://learn.chatgpt.com/docs/extend/mcp
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- https://community.openai.com/t/chatgpt-connector-returns-empty-for-mcp-tool-results-with-type-image-while-same-tool-works-in-mcp-inspector/1375446
- https://community.openai.com/t/feature-request-support-mcp-tasks-extension-sep-2663-mcp-2026-07-28-in-chatgpt-developer-mode/1391486
- https://github.com/openai/codex/issues/11845
- https://github.com/openai/codex/issues/10334
- https://github.com/openai/codex/pull/17043

Other clients
- https://cursor.com/docs/context/mcp
- https://code.visualstudio.com/docs/copilot/chat/mcp-servers
- https://code.visualstudio.com/api/extension-guides/ai/mcp
- https://github.blog/changelog/2025-05-08-github-copilot-in-vs-code-april-release-v1-100/
- https://docs.devin.ai/desktop/cascade/mcp
- https://docs.openclaw.ai/cli/mcp/transports
- https://docs.openclaw.ai/cli/mcp/registry
- https://github.com/openclaw/openclaw/issues/41789
- https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
- https://hermes-agent.nousresearch.com/docs/user-guide/features/vision
- https://github.com/NousResearch/hermes-agent/pull/21328
- https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html
- https://geminicli.com/docs/changelogs/
- https://github.com/google-gemini/gemini-cli/issues/22249
- https://goose-docs.ai/docs/guides/mcp-elicitation/
- https://block.github.io/goose/docs/guides/mcp-sampling/
- https://zed.dev/docs/ai/mcp
- https://github.com/zed-industries/zed/issues/30243
- https://github.com/cline/cline/blob/main/CHANGELOG.md
- https://github.com/cline/cline/issues/1865
- https://github.com/cline/cline/discussions/4522
- https://canimcp.dev/ (community matrix, per-client pages cite their sources)
