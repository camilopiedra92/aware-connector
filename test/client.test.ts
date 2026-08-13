import { test } from "node:test";
import assert from "node:assert/strict";
import { AwareClient, AwareApiError, findByEmail, formatPersonLines, searchPeople, type Person } from "../src/client.ts";

/** Minimal fake matching the slice of TokenManager the client depends on. */
function fakeTokens(tokens: string[]) {
  let i = 0;
  let forced = 0;
  return {
    manager: {
      getAccessToken: async () => tokens[Math.min(i, tokens.length - 1)]!,
      forceRefresh: async () => {
        i++;
        forced++;
        return tokens[Math.min(i, tokens.length - 1)]!;
      },
    },
    forcedCount: () => forced,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function person(overrides: Partial<Person>): Person {
  return {
    Worker_ID: "0",
    Preferred_Name: "",
    Work_Email: "",
    Business_Title: "",
    Managers_Display_Name: "",
    Managers_Worker_ID: "",
    Supervisory_Organization_Name: "",
    Work_Location_City: "",
    Work_Location_Country: "",
    ...overrides,
  };
}

test("getPeople sends a Bearer token and returns the parsed feed", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url, init) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return jsonResponse(200, { Report_Entry: [person({ Worker_ID: "42", Work_Email: "me@autodesk.com" })] });
  }) as typeof fetch;

  const { manager } = fakeTokens(["tok-1"]);
  const people = await new AwareClient({ tokenManager: manager, fetchImpl }).getPeople();

  assert.equal(people.length, 1);
  assert.equal(people[0]!.Worker_ID, "42");
  assert.equal(seen[0]!.auth, "Bearer tok-1");
  assert.match(seen[0]!.url, /\/data\/people\.json$/);
});

test("a 401 triggers exactly one refresh-and-retry with the new token", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (_url, init) => {
    const auth = new Headers(init?.headers).get("authorization")!;
    calls.push(auth);
    if (auth === "Bearer tok-1") return jsonResponse(401, { message: "expired" });
    return jsonResponse(200, { Report_Entry: [] });
  }) as typeof fetch;

  const { manager, forcedCount } = fakeTokens(["tok-1", "tok-2"]);
  const people = await new AwareClient({ tokenManager: manager, fetchImpl }).getPeople();

  assert.deepEqual(people, []);
  assert.deepEqual(calls, ["Bearer tok-1", "Bearer tok-2"]);
  assert.equal(forcedCount(), 1);
});

test("a persistent 401 after retry surfaces as AwareApiError", async () => {
  const fetchImpl = (async () => jsonResponse(401, { message: "nope" })) as typeof fetch;
  const { manager, forcedCount } = fakeTokens(["tok-1", "tok-2"]);
  const client = new AwareClient({ tokenManager: manager, fetchImpl });

  await assert.rejects(() => client.getPeople(), AwareApiError);
  assert.equal(forcedCount(), 1); // retried once, not in a loop
});

test("searchPeople matches name, email, or title, case-insensitively", () => {
  const people = [
    person({ Worker_ID: "1", Preferred_Name: "Andrew Anagnost", Business_Title: "CEO" }),
    person({ Worker_ID: "2", Preferred_Name: "Jane Doe", Work_Email: "jane.doe@autodesk.com" }),
    person({ Worker_ID: "3", Preferred_Name: "Bob Smith", Business_Title: "Principal Engineer" }),
  ];

  assert.deepEqual(searchPeople(people, "anagnost").map((p) => p.Worker_ID), ["1"]);
  assert.deepEqual(searchPeople(people, "jane.doe@").map((p) => p.Worker_ID), ["2"]);
  assert.deepEqual(searchPeople(people, "engineer").map((p) => p.Worker_ID), ["3"]);
  assert.equal(searchPeople(people, "nobody").length, 0);
  assert.equal(searchPeople(people, "  ").length, 0);
});

test("formatPersonLines omits fields that are missing from the feed record", () => {
  // 123 real records lack Work_Location_City; the location must not read "undefined, ...".
  const lines = formatPersonLines(person({
    Preferred_Name: "Jane Doe",
    Business_Title: "Engineer",
    Work_Email: "jane@autodesk.com",
    Work_Location_City: "",
    Work_Location_Country: "United States",
    Managers_Display_Name: "Bob",
    Supervisory_Organization_Name: "Platform",
  }));
  assert.deepEqual(lines, [
    "Jane Doe  ·  Engineer",
    "  jane@autodesk.com  ·  United States",
    "  manager: Bob  ·  org: Platform",
  ]);
  assert.ok(!lines.join("\n").includes("undefined"));
});

test("formatPersonLines drops the manager/org line when both are absent", () => {
  const lines = formatPersonLines(person({ Preferred_Name: "Solo", Work_Email: "solo@x.com" }));
  assert.equal(lines.length, 2); // name/title line + email line, no chain line
  assert.ok(!lines.join("\n").includes("manager:"));
});

test("findByEmail matches one person case-insensitively", () => {
  const people = [
    person({ Worker_ID: "1", Work_Email: "jane.doe@autodesk.com" }),
    person({ Worker_ID: "2", Work_Email: "bob@autodesk.com" }),
  ];
  assert.equal(findByEmail(people, "JANE.DOE@autodesk.com")?.Worker_ID, "1");
  assert.equal(findByEmail(people, "nobody@autodesk.com"), undefined);
});
