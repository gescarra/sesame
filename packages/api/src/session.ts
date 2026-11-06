// The session cookie, shared by every sesame web function on the distribution's origin.
import { seal, unseal } from "./seal.ts";

export const SESSION_COOKIE = "__Host-sesame_session";
/** Absolute session lifetime. A user past it goes back through Cognito, usually without a prompt. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** What a session cookie carries. */
export interface SessionUser {
  sub: string;
  /** Normalized, trusted email; the key for mailbox membership. */
  email: string;
  name?: string;
  /** Cognito groups at sign-in. A change takes effect at the next sign-in. */
  groups?: string[];
}

export function sealSession(key: Buffer, user: SessionUser, now = Date.now()): string {
  return seal(key, "session", user, SESSION_TTL_SECONDS, now);
}

export function readSession(
  key: Buffer,
  value: string | undefined,
  now = Date.now(),
): SessionUser | undefined {
  return unseal<SessionUser>(key, "session", value, now);
}
