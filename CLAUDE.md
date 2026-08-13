# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                              # runtime deps are MCP-only (see below); the CLI uses none
node src/cli.ts <command>                # run the CLI (login | me | search <q> | people | logout)
node src/cli.ts search <q> --limit 5     # search flags: --limit N, --all; --refresh bypasses the feed cache
node src/mcp.ts                          # run the MCP server (speaks JSON-RPC on stdio; not interactive)
npm test                                 # run all tests (node --test over test/*.ts)
node --test test/auth.test.ts            # run a single test file
node --test --test-name-pattern="refresh" # run tests whose name matches a pattern
npm run typecheck                        # tsc --noEmit (the only "build" — nothing is compiled/emitted)
```

There is no linter or build step. TypeScript runs directly via Node's native
type-stripping; `tsc` is used only for type-checking.

## Runtime constraints

- **Node 24+ and macOS only.** Relies on native `fetch`, TS type-stripping, `node:test`,
  and `parseArgs`, plus the macOS `security` CLI (keychain) and `pbpaste` (bootstrap).
  24 is the floor because it is the active LTS, not because of a language feature —
  the code also runs on 22.18+, where type-stripping stopped needing a flag. Development
  happens on the version `mise.toml` pins (26); CI proves both ends of that range.
- **Node type-stripping is strip-only**, so TS syntax that emits code is forbidden:
  no parameter properties (`constructor(private x)` — declare fields explicitly), no
  enums, no namespaces. Local `.ts` imports must include the `.ts` extension.
- **Runtime deps are confined to the MCP entry point.** `@modelcontextprotocol/server` and
  `zod` exist only for `src/mcp.ts`; `src/cli.ts` and everything it imports stay dependency-free,
  so `node src/cli.ts` works against an empty `node_modules`. Keep it that way. `@modelcontextprotocol/server`
  is deliberately not `@modelcontextprotocol/sdk`: the latter pulls express/hono for HTTP
  transports this stdio server never uses (91 packages vs 2).

## Architecture

A CLI that reads Autodesk Aware, which has no public API or MCP. The whole design
follows from two reverse-engineered facts (constants live in `src/config.ts`):

1. **Auth is AWS Cognito, not Autodesk Platform Services.** Aware's tokens come from a
   Cognito user pool (federated to Azure AD). The connector stores a long-lived **refresh
   token** and mints 1h access tokens on demand.
2. **People/org data is a static CDN feed, not a REST API.** The authoritative source is
   `people.json` on Aware's CloudFront — a Workday RaaS export shaped `{ Report_Entry: [...] }`
   (~20k people, read with a Bearer token). The `/api/v1` REST endpoints exist but use AWS
   IAM (SigV4) auth and hold only write-only profile features (no org data), so they are
   **intentionally not implemented**.

Data flow, spanning modules:

```
keychain (refresh token) ──▶ auth.TokenManager ──▶ 1h access token
                                                        │ Bearer
                                          client.AwareClient ──▶ CDN people.json feed
                                                        │
                             session.loadPeople (30-min disk cache) ──▶ Person[]
                                            ╱                    ╲
                                     cli.ts (text)          tools.ts (JSON) ──▶ mcp.ts (stdio)
```

- **`src/auth.ts`** — `refreshAccessToken` calls Cognito `InitiateAuth/REFRESH_TOKEN_AUTH`
  (public client, no secret). `TokenManager` caches the access token and only refreshes
  when it is within a safety window of expiry. `now`/`refresh` are injected so tests drive
  the clock and the network. `getIdToken()` returns the id token from the same cached
  session (so `me` resolves identity without a second refresh); `emailFromIdToken` decodes it.
- **`src/client.ts`** — `AwareClient.getPeople()` fetches and unwraps `Report_Entry`.
  `search`/`me` filter that feed **client-side** (mirroring the web app); there is no
  backend search. `#getJson` refreshes once and retries on a 401. `searchPeople`,
  `findByEmail`, and `formatPersonLines` (tolerates fields missing from some records)
  are pure functions, unit-tested directly.
- **`src/cache.ts`** — the ~27 MB feed is cached in `~/Library/Caches/aware-connector`
  with a 30-min TTL (matching Aware's own Workday refresh cadence). The CLI's `loadPeople`
  reads the cache unless `--refresh` is passed. `isFresh` is pure and tested; the fs I/O
  is best-effort (a cache failure never breaks a command).
- **`src/keychain.ts`** — thin wrapper over the macOS `security` CLI. The refresh token
  never touches the repo or a plaintext file.
- **`src/session.ts`** — what the CLI and the MCP server both need: `makeTokenManager`
  (keychain-backed, reader injected for tests) and `loadPeople` (cache-then-network).
  A missing credential raises `MissingCredentialsError` rather than exiting, because the CLI
  wants to die on it and the server has to answer it. It fails *before* the network call:
  Cognito would otherwise reply "Invalid Refresh Token", which misreads as an expired session
  to someone who never logged in.
- **`src/tools.ts`** — the four MCP tool handlers as plain async functions over an injected
  `ToolDeps`. No SDK import, so tests exercise them directly. `guard()` turns every throw into
  an `isError` result — an escaping rejection would kill the stdio process and the client's
  session with it. `clampLimit` coerces an out-of-range limit instead of rejecting it (a model
  asking for 999 is better served 50 than a validation error).
- **`src/server.ts`** — the MCP-facing contract: zod input/output schemas, tool names,
  descriptions, and `readOnlyHint` annotations. `createServer(deps)` returns a server without
  connecting a transport, which is what makes `test/server.test.ts` possible. Tool results carry
  `structuredContent` *and* the same payload serialized into a text block, as the spec asks of
  tools that return structured output.
- **`src/mcp.ts`** — the stdio entry point, and nothing else: build the token manager, the
  client and the deps, then `connect(new StdioServerTransport())`. **stdout is the protocol
  channel** — one `console.log` anywhere in this module graph corrupts the stream and the client
  disconnects; diagnostics go to stderr.
- **`src/cli.ts`** — command dispatch. `promptSecret` reads via the TTY's raw mode, or from
  piped stdin (`pbpaste | aware login`). Bootstrap is paste-only by design: a
  browser-POSTs-to-localhost variant was removed because an unauthenticated local endpoint
  that stores a credential is CSRF-vulnerable (any open web page could plant a token).

## Conventions

- Everything committed is in English (code, comments, commit messages); the repo is public.
- Tests cover logic with real edge cases (token refresh timing, 401-retry, search/email
  filtering, org-chart cycles, cache-vs-network). Wrappers (keychain, CLI dispatch) are not
  unit-tested. `test/server.test.ts` drives the real MCP machinery over `InMemoryTransport`,
  so a renamed tool or a malformed schema fails the suite; the unit tests never see that layer.
- CI (`.github/workflows/ci.yml`) runs the suite and the typecheck on macOS against Node 24
  and 26. A separate job runs `node src/cli.ts` on a bare checkout, before any `npm ci`, so
  the "CLI has no runtime dependencies" rule above fails the build the moment it is broken —
  the unit tests always run with `node_modules` present and cannot see it.
