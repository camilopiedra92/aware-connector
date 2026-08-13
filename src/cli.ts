#!/usr/bin/env node
import { parseArgs } from "node:util";
import { AwareClient, findByEmail, formatPersonLines, searchPeople, type Person } from "./client.ts";
import { emailFromIdToken, refreshAccessToken, RefreshTokenExpiredError, TokenManager } from "./auth.ts";
import { deleteRefreshToken, readRefreshToken, saveRefreshToken } from "./keychain.ts";
import { readFeedCache, writeFeedCache } from "./cache.ts";

const DEFAULT_SEARCH_LIMIT = 20;

const USAGE = `aware-connector — read Autodesk Aware from the terminal

Usage:
  aware login            Store your Cognito refresh token (see below) in the macOS keychain
  aware me               Show your own person record
  aware search <query>   Search people by name, email, or title
  aware people           Fetch the full org feed (~20k people) as JSON on stdout
  aware logout           Remove the stored refresh token

Options:
  --limit N              Max results for search (default ${DEFAULT_SEARCH_LIMIT})
  --all                  Show all matches (overrides --limit)
  --refresh              Bypass the local feed cache and re-fetch

First-time setup (aware login):
  1. Open https://one.autodesk.com/apps/aware/ in Chrome, logged in.
  2. DevTools (Cmd+Opt+I) -> Application -> Cookies -> https://one.autodesk.com
  3. Copy the value of the cookie ending in ".refreshToken"
     (name: CognitoIdentityServiceProvider.<clientId>.<user>.refreshToken)
  4. Run \`aware login\` and paste it when prompted (or: pbpaste | aware login).
     It is validated and stored in your login keychain; it never leaves this machine.`;

// Control characters handled while reading the secret in raw mode.
const ENTER = "\r";
const NEWLINE = "\n";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = "\u007f";
const BACKSPACE_ALT = "\b";

/** Read everything piped into stdin (non-interactive: `pbpaste | aware login`). */
async function readPipedStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/**
 * Read one secret line without echoing it. Uses the TTY's raw mode directly
 * (robust across terminals, unlike readline internals); falls back to reading
 * piped stdin when not attached to a TTY.
 */
function promptSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return readPipedStdin().then((s) => s.split(/\r?\n/, 1)[0]!.trim());
  }

  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return new Promise((resolve) => {
    let buffer = "";
    const finish = (value: string, code?: number) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stdout.write("\n");
      if (code !== undefined) process.exit(code);
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === ENTER || ch === NEWLINE || ch === CTRL_D) return finish(buffer.trim());
        if (ch === CTRL_C) return finish("", 130);
        if (ch === BACKSPACE || ch === BACKSPACE_ALT) { buffer = buffer.slice(0, -1); continue; }
        if (ch >= " ") buffer += ch; // ignore other control chars
      }
    };
    input.on("data", onData);
  });
}

/** A token manager backed by the stored refresh token; exits with guidance if absent. */
function makeTokenManager(): TokenManager {
  return new TokenManager({
    getRefreshToken: async () => {
      const token = await readRefreshToken();
      if (!token) {
        console.error("No stored credentials. Run `aware login` first.");
        process.exit(1);
      }
      return token;
    },
  });
}

/** Load the org feed, preferring the fresh local cache unless `refresh` is set. */
async function loadPeople(client: AwareClient, refresh: boolean): Promise<Person[]> {
  if (!refresh) {
    const cached = readFeedCache();
    if (cached) return cached;
  }
  const people = await client.getPeople();
  writeFeedCache(people);
  return people;
}

async function cmdLogin(): Promise<void> {
  const token = await promptSecret("Paste your Cognito refresh token: ");
  if (!token) {
    console.error("No token provided.");
    process.exit(1);
  }
  process.stdout.write("Validating against Cognito... ");
  try {
    await refreshAccessToken(token);
  } catch (err) {
    if (err instanceof RefreshTokenExpiredError) {
      console.error("rejected.\nThat refresh token is invalid or expired. Grab a fresh one and retry.");
    } else {
      console.error(`failed.\n${(err as Error).message}`);
    }
    process.exit(1);
  }
  await saveRefreshToken(token);
  console.log("ok. Stored in keychain. Try `aware search <name>`.");
}

/** Print one person as a readable block. */
function printPerson(p: Person): void {
  for (const line of formatPersonLines(p)) console.log(line);
}

async function cmdMe(refresh: boolean): Promise<void> {
  const tokenManager = makeTokenManager();
  // One refresh: the id token and the access token used to fetch the feed share it.
  const email = emailFromIdToken((await tokenManager.getIdToken()) ?? "");
  if (!email) {
    console.error("Could not determine your email from the id token.");
    process.exit(1);
  }
  const me = findByEmail(await loadPeople(new AwareClient({ tokenManager }), refresh), email);
  if (!me) {
    console.error(`Signed in as ${email}, but no matching record in the org feed.`);
    process.exit(1);
  }
  printPerson(me);
}

async function cmdSearch(query: string, limit: number, all: boolean, refresh: boolean): Promise<void> {
  if (!query) {
    console.error("Usage: aware search <query> [--limit N] [--all]");
    process.exit(1);
  }
  const matches = searchPeople(await loadPeople(new AwareClient({ tokenManager: makeTokenManager() }), refresh), query);
  if (matches.length === 0) {
    console.error(`No matches for "${query}".`);
    return;
  }
  const shown = all ? matches : matches.slice(0, limit);
  for (const p of shown) printPerson(p);
  if (shown.length < matches.length) {
    console.error(`\nShowing ${shown.length} of ${matches.length} matches. Refine the query, or use --limit N / --all.`);
  } else {
    console.error(`\n${matches.length} match(es).`);
  }
}

async function cmdPeople(refresh: boolean): Promise<void> {
  const people = await loadPeople(new AwareClient({ tokenManager: makeTokenManager() }), refresh);
  console.log(JSON.stringify(people, null, 2));
  console.error(`\n${people.length} people.`);
}

async function cmdLogout(): Promise<void> {
  await deleteRefreshToken();
  console.log("Removed stored credentials.");
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      limit: { type: "string" },
      all: { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
    },
  });
  const [command, ...rest] = positionals;
  const parsedLimit = Number.parseInt(values.limit ?? "", 10);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_SEARCH_LIMIT;
  const all = values.all ?? false;
  const refresh = values.refresh ?? false;

  try {
    switch (command) {
      case "login": return await cmdLogin();
      case "me": return await cmdMe(refresh);
      case "search": return await cmdSearch(rest.join(" "), limit, all, refresh);
      case "people": return await cmdPeople(refresh);
      case "logout": return await cmdLogout();
      default:
        console.log(USAGE);
        process.exit(command ? 1 : 0);
    }
  } catch (err) {
    if (err instanceof RefreshTokenExpiredError) {
      console.error("Your session expired. Run `aware login` again with a fresh refresh token.");
    } else {
      console.error((err as Error).message);
    }
    process.exit(1);
  }
}

await main();
