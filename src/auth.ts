import { COGNITO_CLIENT_ID, COGNITO_IDP_URL } from "./config.ts";

/** Refresh the access token when it has less than this many seconds of life left. */
const EXPIRY_SAFETY_WINDOW_SECONDS = 120;

export interface AccessTokenResult {
  accessToken: string;
  expiresInSeconds: number;
  /** OIDC identity token; present on refresh, carries the user's email/name claims. */
  idToken?: string;
}

/** Decode the `email` claim from an id token's payload (base64url), lowercased, or null. */
export function emailFromIdToken(idToken: string): string | null {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The stored refresh token is no longer valid — the user must re-run `aware login`. */
export class RefreshTokenExpiredError extends Error {
  constructor(message = "Refresh token is invalid or expired; run `aware login` again.") {
    super(message);
    this.name = "RefreshTokenExpiredError";
  }
}

/** Parse a Cognito InitiateAuth response body into an access token, or throw a typed error. */
export function parseInitiateAuthResponse(body: unknown): AccessTokenResult {
  if (typeof body !== "object" || body === null) {
    throw new Error("Unexpected Cognito response: not an object");
  }
  const record = body as Record<string, unknown>;

  if (record["__type"] === "NotAuthorizedException") {
    throw new RefreshTokenExpiredError(String(record["message"] ?? "Not authorized"));
  }

  const result = record["AuthenticationResult"];
  if (typeof result !== "object" || result === null) {
    throw new Error(`Cognito error: ${JSON.stringify(body)}`);
  }
  const auth = result as Record<string, unknown>;
  const accessToken = auth["AccessToken"];
  const expiresIn = auth["ExpiresIn"];
  if (typeof accessToken !== "string" || typeof expiresIn !== "number") {
    throw new Error("Cognito response missing AccessToken/ExpiresIn");
  }
  const idToken = auth["IdToken"];
  return {
    accessToken,
    expiresInSeconds: expiresIn,
    ...(typeof idToken === "string" ? { idToken } : {}),
  };
}

/** Exchange a Cognito refresh token for a fresh access token (public client, no secret). */
export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessTokenResult> {
  const response = await fetchImpl(COGNITO_IDP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  });
  return parseInitiateAuthResponse(await response.json());
}

export interface TokenManagerDeps {
  getRefreshToken: () => Promise<string>;
  refresh?: (refreshToken: string) => Promise<AccessTokenResult>;
  now?: () => number;
}

/**
 * Holds a cached access token and mints a new one from the refresh token only when
 * the cached one is missing or about to expire. Refresh/clock are injectable for tests.
 */
export class TokenManager {
  readonly #getRefreshToken: () => Promise<string>;
  readonly #refresh: (refreshToken: string) => Promise<AccessTokenResult>;
  readonly #now: () => number;
  #cached: { token: string; expiresAtMs: number } | null = null;

  constructor(deps: TokenManagerDeps) {
    this.#getRefreshToken = deps.getRefreshToken;
    this.#refresh = deps.refresh ?? ((rt) => refreshAccessToken(rt));
    this.#now = deps.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    const cached = this.#cached;
    if (cached && cached.expiresAtMs - this.#now() > EXPIRY_SAFETY_WINDOW_SECONDS * 1000) {
      return cached.token;
    }
    return this.forceRefresh();
  }

  async forceRefresh(): Promise<string> {
    const refreshToken = await this.#getRefreshToken();
    const { accessToken, expiresInSeconds } = await this.#refresh(refreshToken);
    this.#cached = {
      token: accessToken,
      expiresAtMs: this.#now() + expiresInSeconds * 1000,
    };
    return accessToken;
  }
}
