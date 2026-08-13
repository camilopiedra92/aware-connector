import { test } from "node:test";
import assert from "node:assert/strict";
import { isFresh } from "../src/cache.ts";

const TTL = 30 * 60 * 1000;

test("isFresh is true within the TTL, false past it", () => {
  assert.equal(isFresh(1_000, 1_000, TTL), true);                 // just written
  assert.equal(isFresh(1_000, 1_000 + TTL - 1, TTL), true);       // one ms before expiry
  assert.equal(isFresh(1_000, 1_000 + TTL, TTL), false);          // exactly at expiry
  assert.equal(isFresh(1_000, 1_000 + TTL + 60_000, TTL), false); // well past
});
