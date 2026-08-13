import {
  directReports,
  findByEmail,
  managerChain,
  searchPeople,
  toPersonSummary,
  type Person,
} from "./client.ts";

// Result sizing. The feed holds ~20k people and every record spent is context the
// model cannot use for anything else, so results are capped rather than complete.
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

/** What the tools need from the outside world. Injected so they stay testable and pure. */
export interface ToolDeps {
  getPeople: () => Promise<Person[]>;
  /** The signed-in user's email, from the id token, or null if it carries none. */
  getEmail: () => Promise<string | null>;
}

/**
 * An MCP `CallToolResult`, narrowed to the text-only shape these tools produce.
 *
 * Declared as a type alias, not an interface: the SDK's result type carries an index
 * signature, and only aliases get an implicit one — an interface here fails to assign.
 */
export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Coerce a model-supplied limit into range instead of rejecting it.
 *
 * A model that asks for 999 results is better served 50 than an input-validation
 * error, which costs a round trip and teaches it nothing it can act on.
 */
export function clampLimit(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(requested), 1), MAX_LIMIT);
}

/**
 * A successful result. The payload is duplicated into a text block because the spec
 * asks tools returning `structuredContent` to serialize it there too, for clients
 * that predate structured output.
 */
function ok(structuredContent: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

/**
 * A failed *call*, not a failed request: `isError` keeps the conversation alive and
 * hands the model something it can act on, where a JSON-RPC error would not.
 */
function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Run a handler, turning any throw into a tool error.
 *
 * Nothing below may escape: an uncaught rejection would take down the stdio process
 * and with it the client's whole session. The messages of the errors we raise
 * (missing credentials, expired refresh token) already say what to do about them.
 */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    return fail((err as Error).message);
  }
}

export function searchTool(deps: ToolDeps, args: { query: string; limit?: number }): Promise<ToolResult> {
  return guard(async () => {
    const matches = searchPeople(await deps.getPeople(), args.query);
    const shown = matches.slice(0, clampLimit(args.limit));
    return ok({
      query: args.query,
      matchCount: matches.length,
      returned: shown.length,
      truncated: matches.length > shown.length,
      people: shown.map(toPersonSummary),
    });
  });
}

export function getPersonTool(deps: ToolDeps, args: { email: string }): Promise<ToolResult> {
  return guard(async () => {
    const person = findByEmail(await deps.getPeople(), args.email);
    if (!person) return fail(`No person in the Aware directory has the email ${args.email}.`);
    return ok({ person: toPersonSummary(person) });
  });
}

export function meTool(deps: ToolDeps): Promise<ToolResult> {
  return guard(async () => {
    const email = await deps.getEmail();
    if (!email) return fail("Could not read your email from the stored session. Run `aware login` again.");
    const person = findByEmail(await deps.getPeople(), email);
    if (!person) return fail(`Signed in as ${email}, but the org feed has no matching record.`);
    return ok({ person: toPersonSummary(person) });
  });
}

export function orgTool(deps: ToolDeps, args: { email: string }): Promise<ToolResult> {
  return guard(async () => {
    const people = await deps.getPeople();
    const person = findByEmail(people, args.email);
    if (!person) return fail(`No person in the Aware directory has the email ${args.email}.`);

    const reports = directReports(people, person);
    return ok({
      person: toPersonSummary(person),
      managerChain: managerChain(people, person).map(toPersonSummary),
      directReports: reports.slice(0, MAX_LIMIT).map(toPersonSummary),
      directReportCount: reports.length,
    });
  });
}
