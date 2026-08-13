import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { DEFAULT_LIMIT, getPersonTool, MAX_LIMIT, meTool, orgTool, searchTool, type ToolDeps } from "./tools.ts";

// The MCP-facing contract: what the tools are called, what they take, what they
// return. Kept apart from the stdio entry point in `mcp.ts` so that building a
// server — in a test, say — does not also seize stdin and stdout.

const PERSON = z.object({
  workerId: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  title: z.string().optional(),
  manager: z.string().optional(),
  managerWorkerId: z.string().optional(),
  organization: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
}).describe("A person in Autodesk's Aware directory. Fields the Workday record lacks are omitted.");

const EMAIL_ARG = z.object({
  email: z.string().describe("Exact Autodesk work email, e.g. jane.doe@autodesk.com."),
});

// Every tool is a read of a static directory feed: read-only, non-destructive,
// idempotent, and backed by data that lives outside this machine.
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Build the Aware MCP server over an injected data source. Does not connect a transport. */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "aware", version: "0.1.0" });

  server.registerTool(
    "aware_search",
    {
      title: "Search Aware people",
      description:
        "Search Autodesk's employee directory by name, email, or job title. Case-insensitive " +
        "substring match across the whole company (~20k people). Results are capped, but the " +
        "true match count is always reported so you can tell when a query needs narrowing.",
      inputSchema: z.object({
        query: z.string().min(1).describe('Fragment of a name, email, or job title — e.g. "anagnost" or "principal engineer".'),
        limit: z.number().int().optional().describe(`How many people to return. Defaults to ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`),
      }),
      outputSchema: z.object({
        query: z.string(),
        matchCount: z.number().describe("Total matches in the directory, before the cap."),
        returned: z.number(),
        truncated: z.boolean().describe("True when matchCount exceeds what was returned."),
        people: z.array(PERSON),
      }),
      annotations: READ_ONLY,
    },
    ({ query, limit }) => searchTool(deps, limit === undefined ? { query } : { query, limit }),
  );

  server.registerTool(
    "aware_get_person",
    {
      title: "Get an Aware person by email",
      description:
        "Look up one person by their exact work email. Use aware_search when you only know part " +
        "of a name or title.",
      inputSchema: EMAIL_ARG,
      outputSchema: z.object({ person: PERSON }),
      annotations: READ_ONLY,
    },
    ({ email }) => getPersonTool(deps, { email }),
  );

  server.registerTool(
    "aware_me",
    {
      title: "Who am I in Aware",
      description:
        "The directory record of the signed-in user, resolved from the stored credentials. " +
        "Use this to learn who you are acting for before answering questions about \"my team\" or \"my manager\".",
      outputSchema: z.object({ person: PERSON }),
      annotations: READ_ONLY,
    },
    () => meTool(deps),
  );

  server.registerTool(
    "aware_org",
    {
      title: "Navigate the Aware org chart",
      description:
        "The reporting line around a person: every manager above them up to the top of the " +
        "company, plus their direct reports. Answers questions like \"who reports to X\" and " +
        "\"where does Y sit in the organization\".",
      inputSchema: EMAIL_ARG,
      outputSchema: z.object({
        person: PERSON,
        managerChain: z.array(PERSON).describe("Nearest manager first, up to the top of the company."),
        directReports: z.array(PERSON).describe(`Immediate reports only, at most ${MAX_LIMIT} of them.`),
        directReportCount: z.number().describe("Total direct reports, even when the list above is capped."),
      }),
      annotations: READ_ONLY,
    },
    ({ email }) => orgTool(deps, { email }),
  );

  return server;
}
