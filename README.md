# aware-connector

[![CI](https://github.com/camilopiedra92/aware-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/camilopiedra92/aware-connector/actions/workflows/ci.yml)

Read Autodesk's Aware employee directory from your terminal, or expose it to an
LLM as an MCP server.

Aware has no public API and no official MCP integration. This connector talks to
the same endpoints the web app does, using your own session, and returns only
data you are already authorized to see.

```console
$ aware search "principal engineer" --limit 2
Jane Doe  ·  Principal Engineer, Platform Services
  jane.doe@autodesk.com  ·  Portland, US
  manager: John Roe  ·  org: Platform Services Engineering
Sam Vale  ·  Principal Engineer, Fusion
  sam.vale@autodesk.com  ·  Toronto, CA
  manager: Alex Kim  ·  org: Fusion Core

Showing 2 of 47 matches. Refine the query, or use --limit N / --all.
```

## Requirements

- **macOS.** The refresh token is stored with the `security` keychain CLI, and
  `pbpaste` is used for the paste-based login.
- **Node 24 or newer** — the active LTS, and the floor CI tests against.
  Development happens on Node 26, which `mise.toml` pins. TypeScript runs directly
  via Node's native type-stripping, so there is no build step and nothing is compiled.

## Install

```bash
git clone https://github.com/camilopiedra92/aware-connector.git
cd aware-connector
npm install          # only needed for the MCP server; the CLI has no runtime deps
npm link             # optional, puts `aware` on your PATH
```

Without `npm link`, run commands as `node src/cli.ts <command>`.

If you manage Node with a version manager (mise, nvm, fnm), be aware that
`npm link` writes into the npm prefix of the *exact* version that is active, so
the command disappears the next time you upgrade Node. A small wrapper on your
PATH that calls `node /path/to/src/cli.ts "$@"` survives that, and lets you pin
which runtime the CLI gets rather than inheriting the current directory's.

## Logging in

Aware issues tokens through an AWS Cognito user pool federated to Azure AD. The
connector stores a long-lived **refresh token** and mints short-lived access
tokens on demand, so you do this once.

1. Open <https://one.autodesk.com/apps/aware/> in Chrome, signed in.
2. DevTools (`Cmd+Opt+I`) → Application → Cookies → `https://one.autodesk.com`.
3. Copy the value of the cookie whose name ends in `.refreshToken`
   (`CognitoIdentityServiceProvider.<clientId>.<user>.refreshToken`).
4. Paste it into `aware login`:

```bash
aware login          # prompts, echo off
pbpaste | aware login   # or straight from the clipboard
```

The token is validated against Cognito before being written to your login
keychain. It never touches the repository, a dotfile, or an environment
variable. `aware logout` removes it.

Bootstrap is paste-only on purpose. An earlier version ran a local HTTP endpoint
for the browser to POST the token to; it was removed because an unauthenticated
localhost endpoint that stores a credential is CSRF-vulnerable — any open web
page could plant a token in your keychain.

## CLI

| Command | What it does |
| --- | --- |
| `aware login` | Store your Cognito refresh token in the keychain |
| `aware me` | Your own directory record |
| `aware search <query>` | Match people by name, email, or job title |
| `aware people` | The full org feed (~20k people) as JSON on stdout |
| `aware logout` | Remove the stored credential |

Flags: `--limit N` (default 20) and `--all` for `search`; `--refresh` on any
read to bypass the local cache and re-fetch.

`search` writes records to stdout and counts to stderr, so `aware people > org.json`
gives you clean JSON with the summary still visible in the terminal.

## MCP server

`src/mcp.ts` speaks JSON-RPC over stdio and exposes four read-only tools:

| Tool | Purpose |
| --- | --- |
| `aware_search` | Search by name, email, or title; reports the true match count when results are capped |
| `aware_get_person` | One person, by exact work email |
| `aware_me` | The signed-in user's own record |
| `aware_org` | The reporting line around a person: managers up, direct reports down |

Register it with Claude Code:

```bash
claude mcp add aware -- node /absolute/path/to/aware-connector/src/mcp.ts
```

Or, for any client that reads a JSON config:

```json
{
  "mcpServers": {
    "aware": {
      "command": "node",
      "args": ["/absolute/path/to/aware-connector/src/mcp.ts"]
    }
  }
}
```

All four tools are annotated `readOnlyHint` — nothing here writes to Aware.
Run `aware login` first; the server reads the same keychain entry the CLI does.

## How it works

Two reverse-engineered facts drive the whole design:

- **Auth is AWS Cognito**, not Autodesk Platform Services. Access tokens last an
  hour and are minted from the stored refresh token as needed.
- **People data is a static CDN feed**, not a REST API — a Workday export on
  CloudFront, read with a Bearer token. There is no backend search, so `search`
  filters the feed client-side exactly as the web app does. The `/api/v1`
  endpoints exist but use AWS IAM (SigV4) auth and carry no org data, so they
  are deliberately not implemented.

The feed is ~27 MB, so it is cached under `~/Library/Caches/aware-connector`
with a 30-minute TTL, matching Aware's own Workday refresh cadence. Cache
failures are non-fatal; `--refresh` skips it.

## Development

```bash
npm test                                   # node --test over test/
node --test test/auth.test.ts              # one file
node --test --test-name-pattern="refresh"  # by test name
npm run typecheck                          # tsc --noEmit; the only "build"
npm run lint                               # eslint . — type-aware rules only
```

There is no bundler: nothing is shipped over a network, so the CLI runs from source
and stack traces need no source maps. Tests cover the parts with real edge cases —
token refresh timing, 401-retry, search and email filtering, org-chart cycles,
cache-vs-network — plus a suite that drives the real MCP server over an in-memory
transport, so a renamed tool or a malformed schema fails the build.

CI runs all of that on macOS against Node 24 and 26, and separately runs the CLI
on a bare checkout with no `npm install`, which is what keeps the "the CLI has no
runtime dependencies" claim honest.

## Disclaimer

Unofficial and unaffiliated with Autodesk. It reads, with your own credentials,
the same directory the Aware web app already shows you; it holds no special
access and writes nothing. Whether running it fits your employer's acceptable-use
policy is on you.

## License

[MIT](LICENSE)
