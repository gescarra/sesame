// Sign-in through Cognito (authorization code + PKCE) with the session kept server-side
// in an encrypted HttpOnly cookie. Tokens never reach browser JavaScript.
import { createHash, randomBytes } from "node:crypto";
import { isValidAddress, normalizeAddress } from "@sesame/core";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { Env, IdClaims } from "./deps.ts";
import { seal, unseal } from "./seal.ts";
import {
  readSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  type SessionUser,
  sealSession,
} from "./session.ts";

export { SESSION_COOKIE, SESSION_TTL_SECONDS };

const LOGIN_COOKIE = "__Host-sesame_login";
const LOGIN_TTL_SECONDS = 10 * 60;

interface LoginState {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
}

const cookieOptions = (maxAge: number) =>
  ({ httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge }) as const;

const random = (bytes: number) => randomBytes(bytes).toString("base64url");

/** Only same-origin paths, so the callback can't be used as an open redirect. */
export function safeReturnTo(value: string | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}

/**
 * The email that keys mailbox membership, or undefined if it can't be trusted.
 * Federated users carry an `identities` claim: their email comes from an IdP an admin
 * configured. Native Cognito users must have a verified email.
 */
export function trustedEmail(claims: IdClaims): string | undefined {
  if (typeof claims.email !== "string" || !isValidAddress(claims.email)) return undefined;
  const federated = Array.isArray(claims.identities) && claims.identities.length > 0;
  const verified = claims.email_verified === true || claims.email_verified === "true";
  return federated || verified ? normalizeAddress(claims.email) : undefined;
}

export const authRoutes = new Hono<Env>();

authRoutes.get("/login", (c) => {
  const { config } = c.var.deps;
  const login: LoginState = {
    state: random(32),
    verifier: random(32),
    nonce: random(16),
    returnTo: safeReturnTo(c.req.query("return")),
  };
  setCookie(
    c,
    LOGIN_COOKIE,
    seal(config.sessionKey, "login", login, LOGIN_TTL_SECONDS),
    cookieOptions(LOGIN_TTL_SECONDS),
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: `${config.publicUrl}/api/auth/callback`,
    scope: "openid email profile",
    state: login.state,
    nonce: login.nonce,
    code_challenge: createHash("sha256").update(login.verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  if (config.identityProvider) params.set("identity_provider", config.identityProvider);
  c.header("Cache-Control", "no-store");
  return c.redirect(`${config.cognitoDomain}/oauth2/authorize?${params}`, 302);
});

authRoutes.get("/callback", async (c) => {
  const { config, verifyIdToken, log } = c.var.deps;
  c.header("Cache-Control", "no-store");
  const login = unseal<LoginState>(config.sessionKey, "login", getCookie(c, LOGIN_COOKIE), c.var.deps.now());
  deleteCookie(c, LOGIN_COOKIE, { path: "/", secure: true });

  const error = c.req.query("error");
  if (error) {
    log("warn", "sign-in returned an error", { error, description: c.req.query("error_description") });
    return c.text("Sign-in failed. Close this tab and try again.", 400);
  }
  const code = c.req.query("code");
  if (!login || !code || c.req.query("state") !== login.state) {
    return c.text("Sign-in expired or was started in another browser. Try again.", 400);
  }

  const tokens = await exchangeCode(c, code, login.verifier);
  let claims: IdClaims;
  try {
    claims = await verifyIdToken(tokens.id_token);
  } catch (err) {
    log("warn", "rejected ID token", { error: String(err) });
    return c.text("Sign-in failed.", 401);
  }
  if (claims.nonce !== login.nonce) return c.text("Sign-in failed.", 401);

  const email = trustedEmail(claims);
  if (!email) {
    log("warn", "sign-in without a trusted email", { sub: claims.sub });
    return c.text("Your account has no verified email address.", 403);
  }
  const user: SessionUser = { sub: claims.sub, email };
  if (typeof claims.name === "string" && claims.name) user.name = claims.name;
  const groups = claims["cognito:groups"];
  if (Array.isArray(groups) && groups.length) user.groups = groups.filter((g) => typeof g === "string");
  setCookie(
    c,
    SESSION_COOKIE,
    sealSession(config.sessionKey, user, c.var.deps.now()),
    cookieOptions(SESSION_TTL_SECONDS),
  );
  log("info", "signed in", { sub: user.sub, email });
  return c.redirect(login.returnTo, 302);
});

authRoutes.post("/logout", (c) => {
  const { config } = c.var.deps;
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  const params = new URLSearchParams({ client_id: config.clientId, logout_uri: `${config.publicUrl}/` });
  // The SPA navigates here to end the Cognito session too.
  return c.json({ logoutUrl: `${config.cognitoDomain}/logout?${params}` });
});

async function exchangeCode(c: Context<Env>, code: string, verifier: string): Promise<{ id_token: string }> {
  const { config, fetch, log } = c.var.deps;
  const res = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: `${config.publicUrl}/api/auth/callback`,
      code_verifier: verifier,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown };
  if (!res.ok || typeof body.id_token !== "string") {
    log("warn", "token exchange failed", { status: res.status, error: body.error });
    throw new HTTPException(401, { message: "Sign-in failed." });
  }
  return { id_token: body.id_token };
}

/** Rejects requests without a valid session cookie. */
export const requireUser: MiddlewareHandler<Env> = async (c, next) => {
  const { config, now } = c.var.deps;
  const user = readSession(config.sessionKey, getCookie(c, SESSION_COOKIE), now());
  if (!user) throw new HTTPException(401, { message: "not signed in" });
  c.set("user", user);
  await next();
};

/**
 * CSRF defense for state-changing requests, on top of SameSite=Lax. A custom header can't be
 * sent cross-origin without a CORS preflight, which the API never approves.
 */
export const requireSameOrigin: MiddlewareHandler<Env> = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const site = c.req.header("sec-fetch-site");
    if (!c.req.header("x-requested-with") || (site && site !== "same-origin")) {
      throw new HTTPException(403, { message: "cross-site request rejected" });
    }
  }
  await next();
};
