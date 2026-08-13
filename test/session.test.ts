import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPeople, makeTokenManager, MissingCredentialsError } from "../src/session.ts";
import type { Person } from "../src/client.ts";

const PERSON = { Worker_ID: "1", Preferred_Name: "Cached" } as unknown as Person;
const FETCHED = { Worker_ID: "2", Preferred_Name: "Fetched" } as unknown as Person;

/** A client and a cache that record what they were asked to do. */
function spies(cached: Person[] | null) {
  const calls = { fetches: 0, writes: [] as Person[][], reads: 0 };
  return {
    calls,
    client: { getPeople: async () => { calls.fetches++; return [FETCHED]; } },
    cache: {
      read: () => { calls.reads++; return cached; },
      write: (people: Person[]) => { calls.writes.push(people); },
    },
  };
}

test("a missing keychain entry surfaces as MissingCredentialsError, not a process exit", async () => {
  // The CLI could exit(1) here; an MCP server must stay alive and answer the call.
  const manager = makeTokenManager(async () => null);
  await assert.rejects(() => manager.getAccessToken(), MissingCredentialsError);
});

test("MissingCredentialsError tells the user how to fix it", async () => {
  const manager = makeTokenManager(async () => null);
  await assert.rejects(() => manager.getAccessToken(), /aware login/);
});

test("loadPeople serves a warm cache without touching the network", async () => {
  const { calls, client, cache } = spies([PERSON]);

  const people = await loadPeople(client, false, cache);

  assert.deepEqual(people, [PERSON]);
  assert.equal(calls.fetches, 0); // a 21 MB download avoided
  assert.deepEqual(calls.writes, []); // nothing new to persist
});

test("loadPeople fetches and repopulates the cache when it is cold", async () => {
  const { calls, client, cache } = spies(null);

  const people = await loadPeople(client, false, cache);

  assert.deepEqual(people, [FETCHED]);
  assert.equal(calls.fetches, 1);
  assert.deepEqual(calls.writes, [[FETCHED]]);
});

test("refresh skips reading the cache but still refills it", async () => {
  const { calls, client, cache } = spies([PERSON]); // a warm cache that must be ignored

  const people = await loadPeople(client, true, cache);

  assert.deepEqual(people, [FETCHED]);
  assert.equal(calls.reads, 0);
  assert.deepEqual(calls.writes, [[FETCHED]]);
});
