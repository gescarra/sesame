// Authenticated encryption for cookie payloads (AES-256-GCM).
// The purpose is bound as associated data, so a login cookie can't be replayed as a session.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

interface Envelope<T> {
  exp: number;
  data: T;
}

/** Encrypts data with an expiry `ttlSeconds` after `now` (milliseconds). */
export function seal<T>(key: Buffer, purpose: string, data: T, ttlSeconds: number, now = Date.now()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const envelope: Envelope<T> = { exp: Math.floor(now / 1000) + ttlSeconds, data };
  const body = Buffer.concat([cipher.update(JSON.stringify(envelope)), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/** Returns the data, or undefined if the value is malformed, tampered with, for another purpose or expired. */
export function unseal<T>(
  key: Buffer,
  purpose: string,
  value: string | undefined,
  now = Date.now(),
): T | undefined {
  if (!value) return undefined;
  const raw = Buffer.from(value, "base64url");
  if (raw.length < IV_BYTES + TAG_BYTES + 1) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)),
      decipher.final(),
    ]);
    const envelope = JSON.parse(plain.toString("utf8")) as Envelope<T>;
    if (typeof envelope.exp !== "number" || envelope.exp * 1000 <= now) return undefined;
    return envelope.data;
  } catch {
    return undefined;
  }
}
