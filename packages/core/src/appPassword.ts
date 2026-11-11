// App passwords: random strings people type into a phone's mail settings once.
// 24 symbols of Crockford base32 carry 120 bits, far beyond guessing, so a plain SHA-256 is
// enough to store them and keeps the check cheap: ActiveSync clients send it on every request.
import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const APP_PASSWORD_LENGTH = 24;
/** A user can hold this many app passwords at once. */
export const MAX_APP_PASSWORDS = 10;
export const MAX_APP_PASSWORD_LABEL = 64;

/** A new password, unformatted. 256 is a multiple of 32, so `byte & 31` is uniform. */
export function newAppPassword(): string {
  return Array.from(randomBytes(APP_PASSWORD_LENGTH), (b) => ALPHABET[b & 31]).join("");
}

/** Groups of four, for showing once: ABCD-EFGH-… */
export function formatAppPassword(password: string): string {
  return password.match(/.{1,4}/g)?.join("-") ?? password;
}

/**
 * What people type back, made comparable: case, spaces and dashes don't matter, and the letters
 * Crockford base32 leaves out read as the digits they look like.
 */
export function normalizeAppPassword(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

export function isWellFormedAppPassword(normalized: string): boolean {
  return normalized.length === APP_PASSWORD_LENGTH && [...normalized].every((ch) => ALPHABET.includes(ch));
}

export function hashAppPassword(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}
