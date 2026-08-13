import { test } from "node:test";
import assert from "node:assert/strict";

// TEMPORARY — proves the CI version matrix actually separates the two Node versions.
// `Temporal` is a global in Node 26 and absent in Node 24, so this must be green on
// one leg of the matrix and red on the other. Reverted once observed.
test("Temporal exists (Node 26 only)", () => {
  assert.ok((globalThis as { Temporal?: unknown }).Temporal, "Temporal is a Node 26 global");
});
