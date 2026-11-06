// DynamoDB key builders. All key formats live here so every package agrees on them.
import { createHash } from "node:crypto";
import { normalizeAddress, normalizeDomain } from "./address.ts";

export const META = "META";

/** Keys for the `sesame-directory` table. */
export const directoryKeys = {
  domain: (domain: string) => ({ pk: `DOMAIN#${normalizeDomain(domain)}`, sk: META }),
  address: (address: string) => ({ pk: `ADDR#${normalizeAddress(address)}`, sk: META }),
  mailbox: (mailboxId: string) => ({ pk: `MBX#${mailboxId}`, sk: META }),
  /** userId is the signed-in user's normalized email claim, so admins can grant access before first login. */
  member: (mailboxId: string, userId: string) => ({
    pk: `MBX#${mailboxId}`,
    sk: `MEMBER#${normalizeAddress(userId)}`,
    gsi1pk: `USER#${normalizeAddress(userId)}`,
    gsi1sk: `MBX#${mailboxId}`,
  }),
  suppression: (address: string) => ({ pk: `SUPPRESS#${normalizeAddress(address)}`, sk: META }),
  rate: (userSub: string, window: string) => ({ pk: `RATE#${userSub}#${window}`, sk: META }),
  /** A deleted mailbox whose mail is still being purged. */
  purge: (mailboxId: string) => ({ pk: `PURGE#${mailboxId}`, sk: META }),
  /** One partition, newest last: admin actions are rare enough not to need sharding. */
  audit: (at: string, id: string) => ({ pk: "AUDIT", sk: `${at}#${id}` }),
};

/** Keys for the `sesame-mail` table. */
export const mailKeys = {
  message: (mailboxId: string, ulid: string) => ({ pk: `MBX#${mailboxId}`, sk: `MSG#${ulid}` }),
  folderView: (mailboxId: string, folder: string, ulid: string) => ({
    gsi1pk: `MBX#${mailboxId}#F#${folder}`,
    gsi1sk: ulid,
  }),
  threadView: (mailboxId: string, threadId: string, ulid: string) => ({
    gsi2pk: `MBX#${mailboxId}#T#${threadId}`,
    gsi2sk: ulid,
  }),
  /** Sparse: set only while a message is flagged. */
  flaggedView: (mailboxId: string, ulid: string) => ({
    gsi3pk: `MBX#${mailboxId}#FLAGGED`,
    gsi3sk: ulid,
  }),
  folderCounter: (mailboxId: string, folder: string) => ({
    pk: `MBX#${mailboxId}`,
    sk: `FOLDER#${folder}`,
  }),
  /** Maps a Message-ID header to its thread. */
  messageIdMap: (mailboxId: string, messageIdHeader: string) => ({
    pk: `MBX#${mailboxId}`,
    sk: `MID#${createHash("sha1").update(messageIdHeader.trim()).digest("hex")}`,
  }),
  /** Maps an SES message ID to the Sent copy whose delivery status SES events update. */
  sesMessage: (sesMessageId: string) => ({ pk: `SES#${sesMessageId}`, sk: META }),
  /** Claimed by the sender before calling SES, so a redelivered job never sends twice. */
  sendLock: (jobId: string) => ({ pk: `SEND#${jobId}`, sk: META }),
  /** Search tokens are sharded by their first two characters so prefix queries hit one partition. */
  searchToken: (mailboxId: string, token: string, ulid: string) => ({
    pk: searchShard(mailboxId, token),
    sk: `${token}#${ulid}`,
  }),
};

export function searchShard(mailboxId: string, tokenOrPrefix: string): string {
  return `MBX#${mailboxId}#S#${tokenOrPrefix.slice(0, 2)}`;
}

/** S3 key prefix for everything stored for one message in one mailbox. */
export function mailboxObjectPrefix(mailboxId: string): string {
  return `mbx/${mailboxId}/`;
}

export function messageObjectPrefix(mailboxId: string, ulid: string): string {
  return `${mailboxObjectPrefix(mailboxId)}${ulid}/`;
}
