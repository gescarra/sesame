// Ids a phone sees. A message's ServerId is "<folder>:<ulid>", as Exchange pairs a folder with
// an item, so a move gives it a new ServerId. An attachment's FileReference is "<ulid>:<partId>".
import { isSystemFolder, type SystemFolder } from "@sesame/core";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function isUlid(value: string): boolean {
  return ULID.test(value);
}

export function serverId(folder: SystemFolder, ulid: string): string {
  return `${folder}:${ulid}`;
}

export function parseServerId(value: string | undefined): { folder: SystemFolder; ulid: string } | undefined {
  const [folder, ulid, ...rest] = (value ?? "").split(":");
  if (rest.length || !isSystemFolder(folder) || !ulid || !isUlid(ulid)) return undefined;
  return { folder, ulid };
}

export function fileReference(ulid: string, partId: string): string {
  return `${ulid}:${partId}`;
}

export function parseFileReference(value: string | undefined): { ulid: string; partId: string } | undefined {
  const [ulid, partId, ...rest] = (value ?? "").split(":");
  if (rest.length || !ulid || !isUlid(ulid) || !partId || !/^[0-9A-Za-z._-]{1,64}$/.test(partId)) {
    return undefined;
  }
  return { ulid, partId };
}

/** A ULID's 128 bits as 16 bytes. */
export function ulidToBytes(ulid: string): Buffer {
  let n = 0n;
  for (const ch of ulid) n = (n << 5n) | BigInt(ALPHABET.indexOf(ch));
  const out = Buffer.alloc(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

export function bytesToUlid(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}
