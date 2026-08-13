#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { emailFromIdToken } from "./auth.ts";
import { AwareClient } from "./client.ts";
import { loadPeople, makeTokenManager } from "./session.ts";
import { createServer } from "./server.ts";
import type { ToolDeps } from "./tools.ts";

// This process talks JSON-RPC over stdout. Nothing else may be written there —
// a stray console.log corrupts the stream and the client drops the connection.
// Diagnostics go to stderr.

// One token manager for the whole process: it caches the access token for its full
// hour, and `me` reads the id token out of that same session instead of refreshing again.
const tokenManager = makeTokenManager();
const client = new AwareClient({ tokenManager });

// The feed is re-read from the 30-minute disk cache on every call (~50 ms) rather
// than held in memory: this process idles most of its life, and 29 MB resident is a
// worse trade than 50 ms per lookup.
const deps: ToolDeps = {
  getPeople: () => loadPeople(client, false),
  getEmail: async () => emailFromIdToken((await tokenManager.getIdToken()) ?? ""),
};

await createServer(deps).connect(new StdioServerTransport());
