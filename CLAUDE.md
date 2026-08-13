# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                              # dev deps only (typescript, @types/node); zero runtime deps
node src/cli.ts <command>                # run the CLI (login | capture | me | search <q> | people | logout)
npm test                                 # run all tests (node --test over test/*.ts)
node --test test/auth.test.ts            # run a single test file
node --test --test-name-pattern="refresh" # run tests whose name matches a pattern
npm run typecheck                        # tsc --noEmit (the only "build" — nothing is compiled/emitted)
```

There is no linter or build step. TypeScript runs directly on Node 26 via native
type-stripping; `tsc` is used only for type-checking.

## Runtime constraints

- **Node 26+ and macOS only.** Relies on native `fetch`, TS type-stripping, `node:test`,
  and `parseArgs`, plus the macOS `security` CLI (keychain) and `pbpaste` (bootstrap).
- **Node type-stripping is strip-only**, so TS syntax that emits code is forbidden:
  no parameter properties (`constructor(private x)` — declare fields explicitly), no
  enums, no namespaces. Local `.ts` imports must include the `.ts` extension.
- Keep runtime dependencies at zero unless there is no stdlib path; that is a design goal, not an accident.

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
```

- **`src/auth.ts`** — `refreshAccessToken` calls Cognito `InitiateAuth/REFRESH_TOKEN_AUTH`
  (public client, no secret). `TokenManager` caches the access token and only refreshes
  when it is within a safety window of expiry. `now`/`refresh` are injected so tests drive
  the clock and the network. `emailFromIdToken` decodes the OIDC id token for `me`.
- **`src/client.ts`** — `AwareClient.getPeople()` fetches and unwraps `Report_Entry`.
  `search` and `me` filter that feed **client-side** (mirroring the web app); there is no
  backend search. `#getJson` refreshes once and retries on a 401. `searchPeople` and
  `findByEmail` are pure functions, unit-tested directly.
- **`src/keychain.ts`** — thin wrapper over the macOS `security` CLI. The refresh token
  never touches the repo or a plaintext file.
- **`src/cli.ts`** — command dispatch. `promptSecret` reads via the TTY's raw mode, or from
  piped stdin (`pbpaste | aware login`). `capture` runs a one-shot localhost listener for a
  browser to POST the token into (bootstrap alternative to paste).

## Conventions

- Everything committed is in English (code, comments, commit messages); the repo may go public.
- Tests cover logic with real edge cases (token refresh timing, 401-retry, search/email
  filtering). Wrappers (keychain, CLI dispatch) are not unit-tested.
