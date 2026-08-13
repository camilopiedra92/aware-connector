import { AWARE_CDN_BASE } from "./config.ts";

/**
 * A person as it appears in Aware's Workday feed. Only the fields we surface are
 * typed; the raw record carries ~32 fields (see people.json). Index signature
 * keeps the rest accessible without widening every consumer to `unknown`.
 */
export interface Person {
  Worker_ID: string;
  Preferred_Name: string;
  Work_Email: string;
  Business_Title: string;
  Managers_Display_Name: string;
  Managers_Worker_ID: string;
  Supervisory_Organization_Name: string;
  Work_Location_City: string;
  Work_Location_Country: string;
  [field: string]: unknown;
}

/** The token slice AwareClient needs — satisfied by TokenManager or a test fake. */
export interface TokenSource {
  getAccessToken: () => Promise<string>;
  forceRefresh: () => Promise<string>;
}

/** A non-2xx response from Aware's API, carrying the status for callers to branch on. */
export class AwareApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body: string) {
    super(`Aware API ${status} for ${url}: ${body.slice(0, 200)}`);
    this.name = "AwareApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export interface AwareClientDeps {
  tokenManager: TokenSource;
  fetchImpl?: typeof fetch;
}

export class AwareClient {
  readonly #tokens: TokenSource;
  readonly #fetch: typeof fetch;

  constructor(deps: AwareClientDeps) {
    this.#tokens = deps.tokenManager;
    this.#fetch = deps.fetchImpl ?? fetch;
  }

  /** GET a Bearer-authenticated JSON endpoint, refreshing once on a 401. */
  async #getJson<T>(url: string): Promise<T> {
    let token = await this.#tokens.getAccessToken();
    let response = await this.#authedGet(url, token);

    // A 401 mid-flight means the access token expired; refresh once and retry.
    if (response.status === 401) {
      token = await this.#tokens.forceRefresh();
      response = await this.#authedGet(url, token);
    }

    if (!response.ok) {
      throw new AwareApiError(response.status, url, await response.text());
    }
    return (await response.json()) as T;
  }

  #authedGet(url: string, token: string): Promise<Response> {
    return this.#fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  }

  /**
   * The full org feed (Workday people export) served as static JSON from the CDN.
   * ~20k records; this is the authoritative people source. The feed is a Workday
   * RaaS document — the array lives under `Report_Entry`. The `/api/v1` REST
   * endpoints (/persons/@me, /search) use AWS IAM (SigV4) auth, not this Bearer
   * token, so they are intentionally not exposed here.
   */
  async getPeople(): Promise<Person[]> {
    const feed = await this.#getJson<{ Report_Entry?: Person[] }>(`${AWARE_CDN_BASE}/data/people.json`);
    return feed.Report_Entry ?? [];
  }

  /**
   * Search the directory by matching the query (case-insensitive) against name,
   * email, and title. Mirrors what the web app does: filter the feed client-side.
   */
  async search(query: string): Promise<Person[]> {
    return searchPeople(await this.getPeople(), query);
  }
}

/** Join present, non-empty parts with a separator (skips fields absent from the feed). */
function joinParts(parts: (string | undefined)[], sep: string): string {
  return parts.map((v) => (v == null ? "" : String(v))).filter((s) => s.length > 0).join(sep);
}

/** Render a person as display lines, tolerating fields missing from some feed records. */
export function formatPersonLines(p: Person): string[] {
  const lines = [joinParts([p.Preferred_Name, p.Business_Title], "  ·  ")];
  const location = joinParts([p.Work_Location_City, p.Work_Location_Country], ", ");
  lines.push("  " + joinParts([p.Work_Email, location], "  ·  "));
  const chain = joinParts([
    p.Managers_Display_Name ? `manager: ${p.Managers_Display_Name}` : "",
    p.Supervisory_Organization_Name ? `org: ${p.Supervisory_Organization_Name}` : "",
  ], "  ·  ");
  if (chain) lines.push("  " + chain);
  return lines;
}

export interface PersonSummary {
  workerId?: string;
  name?: string;
  email?: string;
  title?: string;
  manager?: string;
  managerWorkerId?: string;
  organization?: string;
  city?: string;
  country?: string;
}

/**
 * Project a raw feed record onto the handful of fields worth sending to a model.
 * Records carry ~32 Workday columns; empty ones are dropped rather than emitted as
 * `""`, since a key with no value costs context and tells the reader nothing.
 */
export function toPersonSummary(p: Person): PersonSummary {
  // `string | undefined`, not `string`: Person types these as required, but real feed
  // records omit columns, so the value is missing at runtime however it is declared.
  const fields: [keyof PersonSummary, string | undefined][] = [
    ["workerId", p.Worker_ID],
    ["name", p.Preferred_Name],
    ["email", p.Work_Email],
    ["title", p.Business_Title],
    ["manager", p.Managers_Display_Name],
    ["managerWorkerId", p.Managers_Worker_ID],
    ["organization", p.Supervisory_Organization_Name],
    ["city", p.Work_Location_City],
    ["country", p.Work_Location_Country],
  ];
  const summary: PersonSummary = {};
  for (const [key, value] of fields) {
    const text = value == null ? "" : String(value);
    if (text.length > 0) summary[key] = text;
  }
  return summary;
}

/** Index the feed by Worker_ID, skipping records with no id (they can never be a manager). */
function indexByWorkerId(people: Person[]): Map<string, Person> {
  const byId = new Map<string, Person>();
  for (const p of people) {
    const id = String(p.Worker_ID ?? "");
    if (id) byId.set(id, p);
  }
  return byId;
}

/**
 * The reporting line above a person, nearest manager first, up to the top.
 *
 * The feed is a graph, not a guaranteed tree: a manager id can point at a record
 * the export omitted, or back into the chain during a reorg. Both end the walk —
 * a cycle here would hang the caller, so `seen` is the termination condition, not
 * a defensive extra.
 */
export function managerChain(people: Person[], person: Person): Person[] {
  const byId = indexByWorkerId(people);
  const chain: Person[] = [];
  const seen = new Set<string>([String(person.Worker_ID ?? "")]);

  let current = person;
  for (;;) {
    const managerId = String(current.Managers_Worker_ID ?? "");
    if (!managerId || seen.has(managerId)) return chain;
    const manager = byId.get(managerId);
    if (!manager) return chain;
    seen.add(managerId);
    chain.push(manager);
    current = manager;
  }
}

/** Everyone whose manager is this person. Records with a blank Worker_ID have no reports. */
export function directReports(people: Person[], person: Person): Person[] {
  const id = String(person.Worker_ID ?? "");
  if (!id) return [];
  return people.filter((p) => String(p.Managers_Worker_ID ?? "") === id);
}

/** Find a person by exact email (case-insensitive). Used by the `me` command. */
export function findByEmail(people: Person[], email: string): Person | undefined {
  const target = email.trim().toLowerCase();
  return people.find((p) => String(p.Work_Email ?? "").toLowerCase() === target);
}

/** Pure filter over a people list — matches name, email, or title. Exposed for testing. */
export function searchPeople(people: Person[], query: string): Person[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return people.filter((p) => {
    const haystack = [p.Preferred_Name, p.Work_Email, p.Business_Title]
      .map((v) => String(v ?? "").toLowerCase());
    return haystack.some((field) => field.includes(needle));
  });
}
