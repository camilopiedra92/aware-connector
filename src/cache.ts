import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Person } from "./client.ts";

// The Aware feed refreshes from Workday every ~30 min, so a 30-min local cache
// never serves data staler than the source itself while making repeated commands
// instant. Lives in the macOS user cache dir, never in the repo.
export const FEED_TTL_MS = 30 * 60 * 1000;
const CACHE_DIR = join(homedir(), "Library", "Caches", "aware-connector");
const CACHE_FILE = join(CACHE_DIR, "people.json");

/** Pure freshness check — a cache written at `mtimeMs` is fresh at `nowMs` within `ttlMs`. */
export function isFresh(mtimeMs: number, nowMs: number, ttlMs: number): boolean {
  return nowMs - mtimeMs < ttlMs;
}

/** Return the cached feed if present and still fresh, else null. Never throws. */
export function readFeedCache(ttlMs: number = FEED_TTL_MS, nowMs: number = Date.now()): Person[] | null {
  try {
    if (!isFresh(statSync(CACHE_FILE).mtimeMs, nowMs, ttlMs)) return null;
    return JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Person[];
  } catch {
    return null;
  }
}

/** Persist the feed to the cache. Best-effort: a failure here must not break a command. */
export function writeFeedCache(people: Person[]): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(people));
  } catch {
    /* cache is an optimization, not a requirement */
  }
}
