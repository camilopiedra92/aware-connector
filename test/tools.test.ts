import { test } from "node:test";
import assert from "node:assert/strict";
import type { Person } from "../src/client.ts";
import { MissingCredentialsError } from "../src/session.ts";
import {
  clampLimit,
  DEFAULT_LIMIT,
  getPersonTool,
  MAX_LIMIT,
  meTool,
  orgTool,
  searchTool,
  type ToolDeps,
} from "../src/tools.ts";

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

const PEOPLE: Person[] = [
  person({ Worker_ID: "1", Preferred_Name: "Ceo Person", Work_Email: "ceo@autodesk.com", Business_Title: "CEO" }),
  person({ Worker_ID: "2", Preferred_Name: "Dana Lead", Work_Email: "dana@autodesk.com", Business_Title: "Engineering Manager", Managers_Worker_ID: "1", Managers_Display_Name: "Ceo Person" }),
  person({ Worker_ID: "3", Preferred_Name: "Ana Ruiz", Work_Email: "ana@autodesk.com", Business_Title: "Engineer", Managers_Worker_ID: "2", Managers_Display_Name: "Dana Lead" }),
  person({ Worker_ID: "4", Preferred_Name: "Bruno Diaz", Work_Email: "bruno@autodesk.com", Business_Title: "Engineer", Managers_Worker_ID: "2", Managers_Display_Name: "Dana Lead" }),
];

function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    getPeople: async () => PEOPLE,
    getEmail: async () => "ana@autodesk.com",
    ...overrides,
  };
}

const structured = (result: { structuredContent?: unknown }) => result.structuredContent as Record<string, any>;

test("clampLimit falls back to the default when no limit is given", () => {
  assert.equal(clampLimit(undefined), DEFAULT_LIMIT);
  assert.equal(clampLimit(Number.NaN), DEFAULT_LIMIT);
});

test("clampLimit keeps a sensible limit and bounds an absurd one", () => {
  assert.equal(clampLimit(3), 3);
  assert.equal(clampLimit(MAX_LIMIT + 500), MAX_LIMIT); // a model asking for 999 gets 50, not an error
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-5), 1);
  assert.equal(clampLimit(7.9), 7);
});

test("searchTool caps the returned people but reports the true match count", async () => {
  const result = await searchTool(deps(), { query: "engineer", limit: 1 });

  assert.equal(result.isError, undefined);
  assert.equal(structured(result).matchCount, 3); // Dana (Engineering Manager), Ana, Bruno
  assert.equal(structured(result).people.length, 1);
  assert.equal(structured(result).truncated, true);
});

test("searchTool with no matches is an empty answer, not an error", async () => {
  const result = await searchTool(deps(), { query: "nobody-here" });

  assert.equal(result.isError, undefined);
  assert.equal(structured(result).matchCount, 0);
  assert.deepEqual(structured(result).people, []);
});

test("searchTool returns summaries, never raw feed records", async () => {
  const result = await searchTool(deps(), { query: "ana" });
  assert.deepEqual(Object.keys(structured(result).people[0]).sort(), ["email", "manager", "managerWorkerId", "name", "title", "workerId"].sort());
});

test("getPersonTool reports an unknown email as a tool error naming the address", async () => {
  const result = await getPersonTool(deps(), { email: "ghost@autodesk.com" });

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /ghost@autodesk\.com/);
});

test("meTool resolves the caller from the id token email", async () => {
  const result = await meTool(deps());
  assert.equal(structured(result).person.email, "ana@autodesk.com");
});

test("meTool fails clearly when the id token carries no email", async () => {
  const result = await meTool(deps({ getEmail: async () => null }));

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /aware login/);
});

test("orgTool returns the chain upwards and the direct reports downwards", async () => {
  const result = await orgTool(deps(), { email: "dana@autodesk.com" });

  assert.deepEqual(structured(result).managerChain.map((p: any) => p.name), ["Ceo Person"]);
  assert.deepEqual(structured(result).directReports.map((p: any) => p.name), ["Ana Ruiz", "Bruno Diaz"]);
});

test("orgTool caps a huge report list but still reports the true head count", async () => {
  const boss = person({ Worker_ID: "100", Preferred_Name: "Big Boss", Work_Email: "boss@autodesk.com" });
  const crowd = Array.from({ length: 60 }, (_, i) =>
    person({ Worker_ID: `${200 + i}`, Preferred_Name: `Report ${i}`, Managers_Worker_ID: "100" }));

  const result = await orgTool(deps({ getPeople: async () => [boss, ...crowd] }), { email: "boss@autodesk.com" });

  assert.equal(structured(result).directReports.length, MAX_LIMIT);
  assert.equal(structured(result).directReportCount, 60);
});

test("a missing keychain credential comes back as a tool error, never as a thrown exception", async () => {
  // A throw here would take the stdio server down mid-session; it has to answer instead.
  const broken = deps({ getPeople: async () => { throw new MissingCredentialsError(); } });

  const result = await searchTool(broken, { query: "ana" });

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /aware login/);
});
