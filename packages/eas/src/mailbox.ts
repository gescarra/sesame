// Reads from the mailbox: a folder's messages back to a date, and message objects in S3.
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type MessageItem, mailKeys, type SystemFolder, ulidFloor } from "@sesame/core";
import type { Deps } from "./deps.ts";

/**
 * A folder's messages received at or after `since` (all when undefined), newest first, at most
 * `limit`. GSI1 projects every attribute, so the items are complete.
 */
export async function listWindow(
  deps: Deps,
  mailboxId: string,
  folder: SystemFolder,
  since: number | undefined,
  limit: number,
): Promise<MessageItem[]> {
  const items: MessageItem[] = [];
  const gsi1pk = mailKeys.folderView(mailboxId, folder, "").gsi1pk;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await deps.doc.send(
      new QueryCommand({
        TableName: deps.config.mailTable,
        IndexName: "gsi1",
        KeyConditionExpression: since === undefined ? "gsi1pk = :p" : "gsi1pk = :p AND gsi1sk >= :since",
        ExpressionAttributeValues:
          since === undefined ? { ":p": gsi1pk } : { ":p": gsi1pk, ":since": ulidFloor(since) },
        ScanIndexForward: false,
        Limit: Math.min(1000, limit - items.length),
        ExclusiveStartKey,
      }),
    );
    items.push(...((res.Items ?? []) as MessageItem[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey && items.length < limit);
  return items;
}

/**
 * A folder's change signal: ingest and every message change bump `version` on the folder
 * counter, in the same transaction as the message. `updatedAt` is when (ms; 0 if never).
 */
export interface FolderVersion {
  version: number;
  updatedAt: number;
}

function toVersion(item: Record<string, unknown> | undefined): FolderVersion {
  return {
    version: Number(item?.version ?? 0),
    updatedAt: item?.updatedAt ? Date.parse(String(item.updatedAt)) : 0,
  };
}

/** One folder's version, read consistently: Sync stores it as the point the phone has seen. */
export async function folderVersion(deps: Deps, mailboxId: string, folder: SystemFolder) {
  const res = await deps.doc.send(
    new GetCommand({
      TableName: deps.config.mailTable,
      Key: mailKeys.folderCounter(mailboxId, folder),
      ConsistentRead: true,
    }),
  );
  return toVersion(res.Item);
}

/** Every folder's version in one small query: what Ping polls. */
export async function folderVersions(deps: Deps, mailboxId: string): Promise<Map<string, FolderVersion>> {
  const res = await deps.doc.send(
    new QueryCommand({
      TableName: deps.config.mailTable,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :f)",
      ExpressionAttributeValues: { ":pk": mailKeys.folderCounter(mailboxId, "").pk, ":f": "FOLDER#" },
    }),
  );
  return new Map((res.Items ?? []).map((i) => [String(i.sk).slice("FOLDER#".length), toVersion(i)]));
}

export class ObjectMissingError extends Error {}

/**
 * One of a message's objects, or its first `maxBytes` bytes. `size` is the whole object's size.
 */
export async function readObject(
  deps: Deps,
  key: string,
  range?: { start: number; end: number },
): Promise<{ bytes: Buffer; size: number; contentType?: string }> {
  try {
    const res = await deps.s3.send(
      new GetObjectCommand({
        Bucket: deps.config.mailBucket,
        Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
    );
    const bytes = Buffer.from((await res.Body?.transformToByteArray()) ?? new Uint8Array(0));
    // Content-Range is "bytes 0-99/1234" for a range; otherwise the length is the size.
    const total = res.ContentRange?.match(/\/(\d+)$/)?.[1];
    const out: { bytes: Buffer; size: number; contentType?: string } = {
      bytes,
      size: total ? Number(total) : (res.ContentLength ?? bytes.length),
    };
    if (res.ContentType) out.contentType = res.ContentType;
    return out;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey" || name === "NotFound") throw new ObjectMissingError(key);
    // A range starting past the end of a non-empty object.
    if (name === "InvalidRange") return { bytes: Buffer.alloc(0), size: 0 };
    throw err;
  }
}

/** The text and sanitized HTML ingest extracted, or nothing when there's none. */
export async function readBodyJson(
  deps: Deps,
  message: MessageItem,
): Promise<{ text?: string; html?: string }> {
  try {
    const { bytes } = await readObject(deps, `${message.objectPrefix}body.json`);
    return JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    if (err instanceof ObjectMissingError) return {};
    throw err;
  }
}
