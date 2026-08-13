import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { Person } from "../src/client.ts";
import { createServer } from "../src/server.ts";
import type { ToolDeps } from "../src/tools.ts";

// These tests drive the server through the real MCP machinery — schema validation,
// dispatch, result serialization — over an in-memory transport. They are what catches
// a renamed tool, a malformed schema, or a handler wired to the wrong name; the unit
// tests in tools.test.ts never see any of that.

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
  person({ Worker_ID: "2", Preferred_Name: "Ana Ruiz", Work_Email: "ana@autodesk.com", Business_Title: "Engineer", Managers_Worker_ID: "1", Managers_Display_Name: "Ceo Person" }),
];

const DEPS: ToolDeps = {
  getPeople: async () => PEOPLE,
  getEmail: async () => "ana@autodesk.com",
};

/** A connected server plus a `call` helper that speaks raw JSON-RPC into it. */
async function connect(deps: ToolDeps = DEPS) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(deps);
  await server.connect(serverSide);

  let nextId = 1;
  const request = (method: string, params: unknown) => {
    const id = nextId++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 5000);
      clientSide.onmessage = (message: any) => {
        if (message.id !== id) return;
        clearTimeout(timer);
        resolve(message);
      };
      void clientSide.send({ jsonrpc: "2.0", id, method, params } as any);
    });
  };

  await clientSide.start();
  await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  });
  void clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" } as any);

  return {
    request,
    call: (name: string, args: Record<string, unknown> = {}) =>
      request("tools/call", { name, arguments: args }).then((m) => m.result),
    close: () => server.close(),
  };
}

test("the server advertises exactly the four read-only tools", async () => {
  const session = await connect();
  const { result } = await session.request("tools/list", {});

  assert.deepEqual(
    result.tools.map((t: any) => t.name).sort(),
    ["aware_get_person", "aware_me", "aware_org", "aware_search"],
  );
  for (const tool of result.tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be marked read-only`);
    assert.ok(tool.outputSchema, `${tool.name} must declare an output schema`);
    assert.ok(tool.description, `${tool.name} must carry a description for the model`);
  }
  await session.close();
});

test("a tool call round-trips through schema validation into structured content", async () => {
  const session = await connect();

  const result = await session.call("aware_search", { query: "ana" });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.people[0].name, "Ana Ruiz");
  // The spec asks structured results to be serialized into a text block as well.
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  await session.close();
});

test("aware_org is reachable by name and returns the reporting line", async () => {
  const session = await connect();

  const result = await session.call("aware_org", { email: "ana@autodesk.com" });

  assert.deepEqual(result.structuredContent.managerChain.map((p: any) => p.name), ["Ceo Person"]);
  await session.close();
});

test("a not-found lookup comes back as a tool error, not a JSON-RPC error", async () => {
  const session = await connect();

  const message = await session.request("tools/call", {
    name: "aware_get_person",
    arguments: { email: "ghost@autodesk.com" },
  });

  assert.equal(message.error, undefined, "must not surface as a protocol-level error");
  assert.equal(message.result.isError, true);
  await session.close();
});

test("a bad argument is rejected by the declared input schema", async () => {
  const session = await connect();

  const result = await session.call("aware_search", { query: 42 });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /query/);
  await session.close();
});

test("calling an unknown tool fails without taking the server down", async () => {
  const session = await connect();

  await session.request("tools/call", { name: "aware_delete_everything", arguments: {} });
  const stillAlive = await session.call("aware_me");

  assert.equal(stillAlive.structuredContent.person.email, "ana@autodesk.com");
  await session.close();
});
