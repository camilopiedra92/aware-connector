import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emailFromIdToken,
  parseInitiateAuthResponse,
  RefreshTokenExpiredError,
  TokenManager,
} from "../src/auth.ts";

/** Build an unsigned JWT with the given payload (header.payload.sig, base64url). */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

test("parseInitiateAuthResponse extracts access token, id token, and expiry", () => {
  const parsed = parseInitiateAuthResponse({
    AuthenticationResult: { AccessToken: "abc.def.ghi", IdToken: "id.tok.en", ExpiresIn: 3600 },
  });
  assert.equal(parsed.accessToken, "abc.def.ghi");
  assert.equal(parsed.idToken, "id.tok.en");
  assert.equal(parsed.expiresInSeconds, 3600);
});

test("emailFromIdToken decodes the email claim, lowercased", () => {
  assert.equal(emailFromIdToken(fakeJwt({ email: "Andrew.Anagnost@autodesk.com" })), "andrew.anagnost@autodesk.com");
});

test("emailFromIdToken returns null when there is no email claim or the token is malformed", () => {
  assert.equal(emailFromIdToken(fakeJwt({ sub: "x" })), null);
  assert.equal(emailFromIdToken("not-a-jwt"), null);
});

test("parseInitiateAuthResponse throws typed error on invalid refresh token", () => {
  assert.throws(
    () =>
      parseInitiateAuthResponse({
        __type: "NotAuthorizedException",
        message: "Invalid Refresh Token",
      }),
    RefreshTokenExpiredError,
  );
});

test("parseInitiateAuthResponse throws on a malformed body", () => {
  assert.throws(() => parseInitiateAuthResponse({ AuthenticationResult: {} }));
});

test("TokenManager fetches once and caches until near expiry", async () => {
  let calls = 0;
  let clock = 1_000;
  const tm = new TokenManager({
    getRefreshToken: async () => "rt",
    refresh: async () => {
      calls++;
      return { accessToken: `token-${calls}`, expiresInSeconds: 3600 };
    },
    now: () => clock,
  });

  assert.equal(await tm.getAccessToken(), "token-1");
  clock += 1000 * 1000; // +1000s, still well within the 1h token
  assert.equal(await tm.getAccessToken(), "token-1");
  assert.equal(calls, 1);
});

test("TokenManager refreshes again once the token is within the safety window", async () => {
  let calls = 0;
  let clock = 1_000;
  const tm = new TokenManager({
    getRefreshToken: async () => "rt",
    refresh: async () => {
      calls++;
      return { accessToken: `token-${calls}`, expiresInSeconds: 3600 };
    },
    now: () => clock,
  });

  assert.equal(await tm.getAccessToken(), "token-1");
  clock += 3600 * 1000; // jump a full hour → past the safety window
  assert.equal(await tm.getAccessToken(), "token-2");
  assert.equal(calls, 2);
});

test("TokenManager.forceRefresh invalidates the cached token", async () => {
  let calls = 0;
  const tm = new TokenManager({
    getRefreshToken: async () => "rt",
    refresh: async () => {
      calls++;
      return { accessToken: `token-${calls}`, expiresInSeconds: 3600 };
    },
    now: () => 1_000,
  });

  assert.equal(await tm.getAccessToken(), "token-1");
  await tm.forceRefresh();
  assert.equal(await tm.getAccessToken(), "token-2");
  assert.equal(calls, 2);
});
