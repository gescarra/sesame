import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { safeReturnTo, trustedEmail } from "./auth.ts";
import type { IdClaims } from "./deps.ts";
import { seal, unseal } from "./seal.ts";
import { readSession } from "./session.ts";
import { ddbMock, NOW, testApp, testDeps } from "./testing.ts";

const key = Buffer.alloc(32, 1);

describe("seal", () => {
  it("round-trips data until it expires", () => {
    const value = seal(key, "session", { a: 1 }, 60, NOW);
    expect(unseal(key, "session", value, NOW + 59_000)).toEqual({ a: 1 });
    expect(unseal(key, "session", value, NOW + 60_000)).toBeUndefined();
  });

  it("rejects another purpose, another key and tampering", () => {
    const value = seal(key, "login", { a: 1 }, 60, NOW);
    expect(unseal(key, "session", value, NOW)).toBeUndefined();
    expect(unseal(Buffer.alloc(32, 2), "login", value, NOW)).toBeUndefined();
    const raw = Buffer.from(value, "base64url");
    raw[20] = (raw[20] ?? 0) ^ 1;
    expect(unseal(key, "login", raw.toString("base64url"), NOW)).toBeUndefined();
    expect(unseal(key, "login", "garbage", NOW)).toBeUndefined();
  });
});

describe("trustedEmail", () => {
  it("trusts federated users and verified native users", () => {
    expect(
      trustedEmail({ sub: "1", email: "Alice@Example.com", identities: [{ providerName: "Okta" }] }),
    ).toBe("alice@example.com");
    expect(trustedEmail({ sub: "1", email: "a@example.com", email_verified: true })).toBe("a@example.com");
    expect(trustedEmail({ sub: "1", email: "a@example.com", email_verified: "true" })).toBe("a@example.com");
  });

  it("rejects unverified or missing email", () => {
    expect(trustedEmail({ sub: "1", email: "a@example.com", email_verified: false })).toBeUndefined();
    expect(trustedEmail({ sub: "1", email: "a@example.com" })).toBeUndefined();
    expect(trustedEmail({ sub: "1", email_verified: true })).toBeUndefined();
    expect(trustedEmail({ sub: "1", email: "nope", identities: [{}] })).toBeUndefined();
  });
});

describe("safeReturnTo", () => {
  it("only allows same-origin paths", () => {
    expect(safeReturnTo("/mail/inbox?x=1")).toBe("/mail/inbox?x=1");
    for (const bad of [undefined, "", "https://evil.test", "//evil.test", "/\\evil.test", "mail"]) {
      expect(safeReturnTo(bad)).toBe("/");
    }
  });
});

/** Runs /login and returns the redirect URL and the login cookie it set. */
async function startLogin(app: ReturnType<typeof testApp>, returnTo = "/mail") {
  const res = await app.request(`/api/auth/login?return=${encodeURIComponent(returnTo)}`);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { location, cookie };
}

function callbackDeps(claims: Partial<IdClaims>) {
  const calls: { url: string; body: string }[] = [];
  const deps = testDeps({
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return Response.json({ id_token: "id.token.sig", access_token: "a", refresh_token: "r" });
    },
    verifyIdToken: async (token) => {
      expect(token).toBe("id.token.sig");
      return { sub: "sub-1", ...claims } as IdClaims;
    },
  });
  return { deps, calls };
}

describe("sign-in flow", () => {
  it("redirects to Cognito with PKCE, state and nonce", async () => {
    const app = testApp(testDeps());
    const { location, cookie } = await startLogin(app);
    expect(location.origin + location.pathname).toBe(
      "https://sesame.auth.us-east-1.amazoncognito.com/oauth2/authorize",
    );
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client123",
      redirect_uri: "https://mail.example.com/api/auth/callback",
      code_challenge_method: "S256",
      scope: "openid email profile",
    });
    expect(location.searchParams.get("state")).toHaveLength(43);
    expect(cookie).toMatch(/^__Host-sesame_login=/);
  });

  it("exchanges the code, verifies the token and sets a session", async () => {
    const { deps, calls } = callbackDeps({ email: "Alice@example.com", email_verified: true, name: "Alice" });
    const app = testApp(deps);
    const { location, cookie } = await startLogin(app, "/mail/inbox");
    const nonce = location.searchParams.get("nonce");
    deps.verifyIdToken = async () => ({
      sub: "sub-1",
      email: "Alice@example.com",
      email_verified: true,
      nonce,
      "cognito:groups": ["sesame-admins"],
    });

    const res = await app.request(`/api/auth/callback?code=abc&state=${location.searchParams.get("state")}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/mail/inbox");
    const setCookies = res.headers.getSetCookie();
    const session = setCookies.find((c) => c.startsWith("__Host-sesame_session="));
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(setCookies.some((c) => c.startsWith("__Host-sesame_login=;"))).toBe(true);
    const value = decodeURIComponent(session?.split(";")[0]?.split("=")[1] ?? "");
    expect(readSession(deps.config.sessionKey, value, deps.now())).toEqual({
      sub: "sub-1",
      email: "alice@example.com",
      groups: ["sesame-admins"],
    });

    expect(calls[0]?.url).toBe("https://sesame.auth.us-east-1.amazoncognito.com/oauth2/token");
    const form = new URLSearchParams(calls[0]?.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("abc");
    expect(form.get("code_verifier")).toHaveLength(43);

    // The new session works.
    ddbMock.reset();
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const me = await app.request("/api/me", { headers: { cookie: session?.split(";")[0] ?? "" } });
    expect(await me.json()).toEqual({ email: "alice@example.com", name: null, mailboxes: [] });
  });

  it("rejects a state mismatch", async () => {
    const { deps, calls } = callbackDeps({});
    const app = testApp(deps);
    const { cookie } = await startLogin(app);
    const res = await app.request("/api/auth/callback?code=abc&state=wrong", { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a nonce mismatch", async () => {
    const { deps } = callbackDeps({ email: "a@example.com", email_verified: true, nonce: "other" });
    const app = testApp(deps);
    const { location, cookie } = await startLogin(app);
    const res = await app.request(`/api/auth/callback?code=abc&state=${location.searchParams.get("state")}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(401);
  });

  it("refuses users without a trusted email", async () => {
    const { deps } = callbackDeps({ email: "a@example.com", email_verified: false });
    const app = testApp(deps);
    const { location, cookie } = await startLogin(app);
    deps.verifyIdToken = async () => ({
      sub: "s",
      email: "a@example.com",
      email_verified: false,
      nonce: location.searchParams.get("nonce"),
    });
    const res = await app.request(`/api/auth/callback?code=abc&state=${location.searchParams.get("state")}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-sesame_session="))).toBe(false);
  });

  it("logs out and returns the Cognito logout URL", async () => {
    const app = testApp(testDeps());
    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { "x-requested-with": "sesame" },
    });
    expect(res.status).toBe(200);
    const { logoutUrl } = (await res.json()) as { logoutUrl: string };
    expect(logoutUrl).toBe(
      "https://sesame.auth.us-east-1.amazoncognito.com/logout?client_id=client123&logout_uri=https%3A%2F%2Fmail.example.com%2F",
    );
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-sesame_session=;/);
  });
});

describe("request guards", () => {
  it("requires a session", async () => {
    const res = await testApp(testDeps()).request("/api/me");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects state changes without the CSRF header or from another site", async () => {
    const app = testApp(testDeps());
    expect((await app.request("/api/auth/logout", { method: "POST" })).status).toBe(403);
    const crossSite = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { "x-requested-with": "sesame", "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
  });
});
