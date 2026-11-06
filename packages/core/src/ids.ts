// ULID-format message IDs: 48-bit millisecond timestamp + 80 bits, Crockford base32.
// IDs sort by time, so DynamoDB sort keys built from them list newest-last.
import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIME = 2 ** 48 - 1;

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) {
    throw new Error(`timestamp out of range: ${ms}`);
  }
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

/** Encodes the first 10 bytes (80 bits) as 16 base32 characters. */
function encodeRandom(bytes: Uint8Array): string {
  let bits = 0n;
  for (let i = 0; i < 10; i++) bits = (bits << 8n) | BigInt(bytes[i] ?? 0);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out = ALPHABET[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

export function newUlid(timeMs: number = Date.now()): string {
  return encodeTime(timeMs) + encodeRandom(randomBytes(10));
}

/**
 * Deterministic ULID: the same (time, seed) always yields the same ID.
 * Ingest uses seed = `${sesMessageId}:${mailboxId}` so redelivered SQS messages
 * produce the same key and conditional puts dedupe them.
 */
export function deterministicUlid(timeMs: number, seed: string): string {
  return encodeTime(timeMs) + encodeRandom(createHash("sha256").update(seed).digest());
}

export function ulidTime(ulid: string): number {
  let ms = 0;
  for (const ch of ulid.slice(0, 10)) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`invalid ULID: ${ulid}`);
    ms = ms * 32 + v;
  }
  return ms;
}

/**
 * The message ID a delivery job produces in a mailbox. The Sent copy gets its own seed, so a
 * message sent to yourself lands twice (Inbox and Sent) without the two colliding.
 */
export function deliveredUlid(
  job: { id: string; receivedAt: string },
  mailboxId: string,
  kind: "received" | "sent",
) {
  const seed = kind === "sent" ? `${job.id}:${mailboxId}:sent` : `${job.id}:${mailboxId}`;
  return deterministicUlid(Date.parse(job.receivedAt), seed);
}
