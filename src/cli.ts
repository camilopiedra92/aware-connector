#!/usr/bin/env node
import { parseArgs } from "node:util";
import { AwareClient, findByEmail } from "./client.ts";
import { emailFromIdToken, refreshAccessToken, RefreshTokenExpiredError, TokenManager } from "./auth.ts";
import { deleteRefreshToken, readRefreshToken, saveRefreshToken } from "./keychain.ts";

const USAGE = `aware-connector — read Autodesk Aware from the terminal

Usage:
  aware login            Store your Cognito refresh token (see below) in the macOS keychain
  aware me               Show your own person record
  aware search <query>   Search people by name, email, or title
  aware people           Fetch the full org feed (~20k people) as JSON on stdout
  aware logout           Remove the stored refresh token

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

/** Build a client backed by the stored refresh token, or exit with guidance if absent. */
async function buildClient(): Promise<AwareClient> {
  const tokenManager = new TokenManager({
    getRefreshToken: async () => {
      const token = await readRefreshToken();
      if (!token) {
        console.error("No stored credentials. Run `aware login` first.");
        process.exit(1);
      }
      return token;
    },
  });
  return new AwareClient({ tokenManager });
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
function printPerson(p: import("./client.ts").Person): void {
  console.log(`${p.Preferred_Name}  ·  ${p.Business_Title}`);
  console.log(`  ${p.Work_Email}  ·  ${p.Work_Location_City}, ${p.Work_Location_Country}`);
  console.log(`  manager: ${p.Managers_Display_Name}  ·  org: ${p.Supervisory_Organization_Name}`);
}

async function cmdMe(): Promise<void> {
  const token = await readRefreshToken();
  if (!token) {
    console.error("No stored credentials. Run `aware login` first.");
    process.exit(1);
  }
  const { idToken } = await refreshAccessToken(token);
  const email = idToken ? emailFromIdToken(idToken) : null;
  if (!email) {
    console.error("Could not determine your email from the id token.");
    process.exit(1);
  }
  const me = findByEmail(await (await buildClient()).getPeople(), email);
  if (!me) {
    console.error(`Signed in as ${email}, but no matching record in the org feed.`);
    process.exit(1);
  }
  printPerson(me);
}

async function cmdSearch(query: string): Promise<void> {
  if (!query) {
    console.error("Usage: aware search <query>");
    process.exit(1);
  }
  const client = await buildClient();
  const matches = await client.search(query);
  if (matches.length === 0) {
    console.error(`No matches for "${query}".`);
    return;
  }
  for (const p of matches) printPerson(p);
  console.error(`\n${matches.length} match(es).`);
}

async function cmdPeople(): Promise<void> {
  const client = await buildClient();
  const people = await client.getPeople();
  console.log(JSON.stringify(people, null, 2));
  console.error(`\n${people.length} people.`);
}

async function cmdLogout(): Promise<void> {
  await deleteRefreshToken();
  console.log("Removed stored credentials.");
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [command, ...rest] = positionals;

  try {
    switch (command) {
      case "login": return await cmdLogin();
      case "me": return await cmdMe();
      case "search": return await cmdSearch(rest.join(" "));
      case "people": return await cmdPeople();
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
