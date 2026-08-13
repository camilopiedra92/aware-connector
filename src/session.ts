import { TokenManager } from "./auth.ts";
import { readRefreshToken } from "./keychain.ts";
import type { Person } from "./client.ts";
import { readFeedCache, writeFeedCache } from "./cache.ts";

/**
 * No refresh token is stored — the user has never run `aware login`, or ran `logout`.
 *
 * This is a typed error rather than an exit because the two front ends need opposite
 * things from it: the CLI prints it and exits, while the MCP server has to stay alive
 * and return it as a failed tool call.
 */
export class MissingCredentialsError extends Error {
  constructor(message = "No stored credentials. Run `aware login` first.") {
    super(message);
    this.name = "MissingCredentialsError";
  }
}

/** A token manager backed by the keychain. The reader is injectable for tests. */
export function makeTokenManager(
  readToken: () => Promise<string | null> = readRefreshToken,
): TokenManager {
  return new TokenManager({
    getRefreshToken: async () => {
      const token = await readToken();
      // Fail before the network call: Cognito would answer "Invalid Refresh Token",
      // which reads as "your session expired" to someone who never logged in.
      if (!token) throw new MissingCredentialsError();
      return token;
    },
  });
}

/** The slice of AwareClient the feed loader needs — satisfied by a client or a test fake. */
export interface PeopleSource {
  getPeople: () => Promise<Person[]>;
}

/** The disk cache, injectable so the loader's branches are testable without touching the fs. */
export interface FeedCache {
  read: () => Person[] | null;
  write: (people: Person[]) => void;
}

const DISK_CACHE: FeedCache = { read: readFeedCache, write: writeFeedCache };

/** Load the org feed, preferring the fresh local cache unless `refresh` is set. */
export async function loadPeople(
  client: PeopleSource,
  refresh: boolean,
  cache: FeedCache = DISK_CACHE,
): Promise<Person[]> {
  if (!refresh) {
    const cached = cache.read();
    if (cached) return cached;
  }
  const people = await client.getPeople();
  cache.write(people);
  return people;
}
