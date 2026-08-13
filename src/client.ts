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
function joinParts(parts: unknown[], sep: string): string {
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
