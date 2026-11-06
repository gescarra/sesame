// Mailbox reads and state changes against the mail table, keeping folder counters in step.
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  type QueryCommandInput,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  batchGet,
  deleteIndex,
  directoryKeys,
  type MailboxAccess,
  type MailboxItem,
  type MemberItem,
  type MessageChanges,
  type MessageDetail,
  type MessageItem,
  type MessageSummary,
  mailKeys,
  type Page,
  SYSTEM_FOLDERS,
  type SystemFolder,
} from "@sesame/core";
import { HTTPException } from "hono/http-exception";
import type { Deps } from "./deps.ts";

export const MAX_PAGE = 100;

export function toSummary(m: MessageItem): MessageSummary {
  const s: MessageSummary = {
    id: m.messageUlid,
    threadId: m.threadId,
    folder: m.folder,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    snippet: m.snippet,
    date: m.date,
    receivedAt: m.receivedAt,
    size: m.size,
    read: m.read,
    flagged: m.flagged,
    hasAttachments: m.hasAttachments,
  };
  if (m.from) s.from = m.from;
  if (m.delivery) s.deliveryStatus = m.delivery.status;
  return s;
}

export function toDetail(m: MessageItem): MessageDetail {
  const d: MessageDetail = { ...toSummary(m), attachments: m.attachments };
  if (m.replyTo) d.replyTo = m.replyTo;
  if (m.messageIdHeader) d.messageIdHeader = m.messageIdHeader;
  if (m.inReplyTo) d.inReplyTo = m.inReplyTo;
  if (m.references) d.references = m.references;
  if (m.auth) d.auth = m.auth;
  if (m.delivery) d.delivery = m.delivery;
  return d;
}

// --- Membership -----------------------------------------------------------

export async function getMembership(
  deps: Deps,
  mailboxId: string,
  email: string,
): Promise<MemberItem | undefined> {
  const key = directoryKeys.member(mailboxId, email);
  const res = await deps.doc.send(
    new GetCommand({ TableName: deps.config.directoryTable, Key: { pk: key.pk, sk: key.sk } }),
  );
  return res.Item as MemberItem | undefined;
}

export async function listMailboxes(deps: Deps, email: string): Promise<MailboxAccess[]> {
  const members: MemberItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await deps.doc.send(
      new QueryCommand({
        TableName: deps.config.directoryTable,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :u",
        ExpressionAttributeValues: { ":u": directoryKeys.member("x", email).gsi1pk },
        ExclusiveStartKey,
      }),
    );
    members.push(...((res.Items ?? []) as MemberItem[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const boxes = (await batchGet(
    deps.doc,
    deps.config.directoryTable,
    members.map((m) => directoryKeys.mailbox(m.mailboxId)),
  )) as unknown as MailboxItem[];
  const byId = new Map(boxes.map((b) => [b.mailboxId, b]));
  return members
    .flatMap((m): MailboxAccess[] => {
      const box = byId.get(m.mailboxId);
      if (!box) return [];
      const access: MailboxAccess = {
        mailboxId: m.mailboxId,
        address: box.primaryAddress,
        role: m.role,
        usedBytes: box.usedBytes ?? 0,
      };
      if (box.displayName) access.displayName = box.displayName;
      if (box.quotaBytes !== undefined) access.quotaBytes = box.quotaBytes;
      return [access];
    })
    .sort((a, b) => a.address.localeCompare(b.address));
}

// --- Folders --------------------------------------------------------------

export async function folderCounts(deps: Deps, mailboxId: string) {
  const res = await deps.doc.send(
    new QueryCommand({
      TableName: deps.config.mailTable,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :f)",
      ExpressionAttributeValues: { ":pk": `MBX#${mailboxId}`, ":f": "FOLDER#" },
    }),
  );
  const counters = new Map((res.Items ?? []).map((i) => [String(i.sk).slice("FOLDER#".length), i]));
  return SYSTEM_FOLDERS.map((name) => {
    const c = counters.get(name);
    // Counters are updated in transactions, but never show a negative count.
    return { name, total: Math.max(0, Number(c?.total ?? 0)), unread: Math.max(0, Number(c?.unread ?? 0)) };
  });
}

// --- Listing --------------------------------------------------------------

type Key = Record<string, string>;

/** Opaque page cursor: the base64url JSON of a LastEvaluatedKey. */
export function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key)).toString("base64url") : undefined;
}

/**
 * Decodes a cursor and checks it belongs to this mailbox and index partition, so a
 * crafted cursor can't start a query in someone else's partition.
 */
export function decodeCursor(cursor: string | undefined, expected: Key): Key | undefined {
  if (!cursor) return undefined;
  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new HTTPException(400, { message: "invalid cursor" });
  }
  if (typeof key !== "object" || key === null || Array.isArray(key)) {
    throw new HTTPException(400, { message: "invalid cursor" });
  }
  const entries = Object.entries(key);
  const ok =
    entries.length <= 6 &&
    entries.every(([, v]) => typeof v === "string") &&
    Object.entries(expected).every(([k, v]) => (key as Key)[k] === v);
  if (!ok) throw new HTTPException(400, { message: "invalid cursor" });
  return key as Key;
}

export interface ListOptions {
  folder: SystemFolder;
  limit: number;
  cursor?: string;
  unreadOnly?: boolean;
}

/** Newest first. The unread filter runs server-side, so short pages are refilled up to `limit`. */
export async function listFolder(
  deps: Deps,
  mailboxId: string,
  opts: ListOptions,
): Promise<Page<MessageSummary>> {
  const gsi1pk = mailKeys.folderView(mailboxId, opts.folder, "").gsi1pk;
  let startKey: Key | undefined = decodeCursor(opts.cursor, { pk: `MBX#${mailboxId}`, gsi1pk });
  const items: MessageItem[] = [];
  for (let round = 0; round < 10 && items.length < opts.limit; round++) {
    const input: QueryCommandInput = {
      TableName: deps.config.mailTable,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :p",
      ExpressionAttributeValues: { ":p": gsi1pk },
      ScanIndexForward: false,
      Limit: opts.limit - items.length,
      ExclusiveStartKey: startKey,
    };
    if (opts.unreadOnly) {
      input.FilterExpression = "#read = :false";
      input.ExpressionAttributeNames = { "#read": "read" };
      input.ExpressionAttributeValues = { ...input.ExpressionAttributeValues, ":false": false };
    }
    const res = await deps.doc.send(new QueryCommand(input));
    items.push(...((res.Items ?? []) as MessageItem[]));
    startKey = res.LastEvaluatedKey as Key | undefined;
    if (!startKey) break;
  }
  const page: Page<MessageSummary> = { items: items.map(toSummary) };
  const cursor = encodeCursor(startKey);
  if (cursor) page.cursor = cursor;
  return page;
}

/** Flagged messages across all folders, newest first. */
export async function listFlagged(
  deps: Deps,
  mailboxId: string,
  opts: { limit: number; cursor?: string },
): Promise<Page<MessageSummary>> {
  const gsi3pk = mailKeys.flaggedView(mailboxId, "").gsi3pk;
  const res = await deps.doc.send(
    new QueryCommand({
      TableName: deps.config.mailTable,
      IndexName: "gsi3",
      KeyConditionExpression: "gsi3pk = :p",
      ExpressionAttributeValues: { ":p": gsi3pk },
      ScanIndexForward: false,
      Limit: opts.limit,
      ExclusiveStartKey: decodeCursor(opts.cursor, { pk: `MBX#${mailboxId}`, gsi3pk }),
    }),
  );
  const page: Page<MessageSummary> = { items: (await hydrate(deps, res.Items ?? [])).map(toSummary) };
  const cursor = encodeCursor(res.LastEvaluatedKey);
  if (cursor) page.cursor = cursor;
  return page;
}

/** Every message in a thread, oldest first. */
export async function listThread(deps: Deps, mailboxId: string, threadId: string): Promise<MessageSummary[]> {
  const keys: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await deps.doc.send(
      new QueryCommand({
        TableName: deps.config.mailTable,
        IndexName: "gsi2",
        KeyConditionExpression: "gsi2pk = :p",
        ExpressionAttributeValues: { ":p": mailKeys.threadView(mailboxId, threadId, "").gsi2pk },
        ExclusiveStartKey,
      }),
    );
    keys.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey && keys.length < 500);
  return (await hydrate(deps, keys)).map(toSummary);
}

/** Loads full items for KEYS_ONLY index results, preserving the index order. */
async function hydrate(deps: Deps, keys: Record<string, unknown>[]): Promise<MessageItem[]> {
  const order = keys.map((k) => String(k.sk));
  const items = (await batchGet(
    deps.doc,
    deps.config.mailTable,
    keys.map((k) => ({ pk: String(k.pk), sk: String(k.sk) })),
  )) as unknown as MessageItem[];
  const bySk = new Map(items.map((i) => [i.sk, i]));
  return order.flatMap((sk) => bySk.get(sk) ?? []);
}

// --- Single messages ------------------------------------------------------

export async function getMessage(deps: Deps, mailboxId: string, id: string, consistent = false) {
  const res = await deps.doc.send(
    new GetCommand({
      TableName: deps.config.mailTable,
      Key: mailKeys.message(mailboxId, id),
      ConsistentRead: consistent,
    }),
  );
  return res.Item as MessageItem | undefined;
}

export async function requireMessage(deps: Deps, mailboxId: string, id: string, consistent = false) {
  const message = await getMessage(deps, mailboxId, id, consistent);
  if (!message) throw new HTTPException(404, { message: "message not found" });
  return message;
}

export async function readBody(deps: Deps, message: MessageItem): Promise<{ text?: string; html?: string }> {
  try {
    const res = await deps.s3.send(
      new GetObjectCommand({ Bucket: deps.config.mailBucket, Key: `${message.objectPrefix}body.json` }),
    );
    return JSON.parse((await res.Body?.transformToString("utf8")) ?? "{}");
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") return {};
    throw err;
  }
}

export type Changes = MessageChanges;

/**
 * Applies read/flag/folder changes and the matching counter deltas in one transaction.
 * The update is conditional on the state it was computed from; on a race it re-reads and retries.
 */
export async function updateMessage(deps: Deps, mailboxId: string, id: string, changes: Changes) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await requireMessage(deps, mailboxId, id, true);
    const next = {
      read: changes.read ?? cur.read,
      flagged: changes.flagged ?? cur.flagged,
      folder: changes.folder ?? cur.folder,
    };
    if (next.read === cur.read && next.flagged === cur.flagged && next.folder === cur.folder) return cur;

    const names: Record<string, string> = { "#read": "read", "#flagged": "flagged", "#folder": "folder" };
    const values: Record<string, unknown> = {
      ":read": next.read,
      ":flagged": next.flagged,
      ":folder": next.folder,
      ":curRead": cur.read,
      ":curFolder": cur.folder,
      ":gsi1pk": mailKeys.folderView(mailboxId, next.folder, id).gsi1pk,
    };
    let update = "SET #read = :read, #flagged = :flagged, #folder = :folder, gsi1pk = :gsi1pk";
    if (next.flagged) {
      const view = mailKeys.flaggedView(mailboxId, id);
      update += ", gsi3pk = :gsi3pk, gsi3sk = :gsi3sk";
      values[":gsi3pk"] = view.gsi3pk;
      values[":gsi3sk"] = view.gsi3sk;
    } else {
      update += " REMOVE gsi3pk, gsi3sk";
    }

    const counters = counterDeltas(cur, next).map(([folder, total, unread]) => ({
      Update: {
        TableName: deps.config.mailTable,
        Key: mailKeys.folderCounter(mailboxId, folder),
        UpdateExpression: "ADD #total :total, #unread :unread SET #updatedAt = :now",
        ExpressionAttributeNames: { "#total": "total", "#unread": "unread", "#updatedAt": "updatedAt" },
        ExpressionAttributeValues: {
          ":total": total,
          ":unread": unread,
          ":now": new Date(deps.now()).toISOString(),
        },
      },
    }));

    try {
      await deps.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: deps.config.mailTable,
                Key: mailKeys.message(mailboxId, id),
                UpdateExpression: update,
                ConditionExpression: "attribute_exists(pk) AND #read = :curRead AND #folder = :curFolder",
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
              },
            },
            ...counters,
          ],
        }),
      );
    } catch (err) {
      if (
        err instanceof TransactionCanceledException &&
        err.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"
      ) {
        continue;
      }
      throw err;
    }
    return { ...cur, ...next };
  }
  throw new HTTPException(409, { message: "message changed concurrently, try again" });
}

/** [folder, totalDelta, unreadDelta] for each counter a state change touches. */
export function counterDeltas(
  cur: { read: boolean; folder: SystemFolder },
  next: { read: boolean; folder: SystemFolder },
): [SystemFolder, number, number][] {
  if (cur.folder !== next.folder) {
    return [
      [cur.folder, -1, cur.read ? 0 : -1],
      [next.folder, 1, next.read ? 0 : 1],
    ];
  }
  if (cur.read !== next.read) return [[cur.folder, 0, next.read ? -1 : 1]];
  return [];
}

/**
 * Deletes a message that is already in trash: its item, counters, quota usage,
 * Message-ID map entry and S3 objects. Messages elsewhere are moved to trash instead.
 */
export async function deleteMessage(
  deps: Deps,
  mailboxId: string,
  id: string,
): Promise<"trashed" | "purged"> {
  const cur = await requireMessage(deps, mailboxId, id, true);
  if (cur.folder !== "trash") {
    await updateMessage(deps, mailboxId, id, { folder: "trash" });
    return "trashed";
  }
  try {
    await deps.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: deps.config.mailTable,
              Key: mailKeys.message(mailboxId, id),
              ConditionExpression: "#folder = :trash",
              ExpressionAttributeNames: { "#folder": "folder" },
              ExpressionAttributeValues: { ":trash": "trash" },
            },
          },
          {
            Update: {
              TableName: deps.config.mailTable,
              Key: mailKeys.folderCounter(mailboxId, "trash"),
              UpdateExpression: "ADD #total :total, #unread :unread",
              ExpressionAttributeNames: { "#total": "total", "#unread": "unread" },
              ExpressionAttributeValues: { ":total": -1, ":unread": cur.read ? 0 : -1 },
            },
          },
          {
            Update: {
              TableName: deps.config.directoryTable,
              Key: directoryKeys.mailbox(mailboxId),
              UpdateExpression: "ADD #used :size",
              ExpressionAttributeNames: { "#used": "usedBytes" },
              ExpressionAttributeValues: { ":size": -cur.size },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (
      err instanceof TransactionCanceledException &&
      err.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"
    ) {
      throw new HTTPException(409, { message: "message changed concurrently, try again" });
    }
    throw err;
  }

  // Best effort after the item is gone: a leftover map entry or object is harmless.
  if (cur.messageIdHeader) {
    await deps.doc
      .send(
        new DeleteCommand({
          TableName: deps.config.mailTable,
          Key: mailKeys.messageIdMap(mailboxId, cur.messageIdHeader),
          ConditionExpression: "messageUlid = :u",
          ExpressionAttributeValues: { ":u": id },
        }),
      )
      .catch(() => undefined);
  }
  if (cur.tokens?.length) {
    await deleteIndex(deps.doc, deps.config.mailTable, mailboxId, id, cur.tokens).catch((err) =>
      deps.log("warn", "could not delete search tokens", { id, error: String(err) }),
    );
  }
  await deleteObjects(deps, cur.objectPrefix).catch((err) =>
    deps.log("warn", "could not delete message objects", { prefix: cur.objectPrefix, error: String(err) }),
  );
  return "purged";
}

async function deleteObjects(deps: Deps, prefix: string) {
  let ContinuationToken: string | undefined;
  do {
    const res = await deps.s3.send(
      new ListObjectsV2Command({ Bucket: deps.config.mailBucket, Prefix: prefix, ContinuationToken }),
    );
    const objects = (res.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (objects.length) {
      await deps.s3.send(
        new DeleteObjectsCommand({
          Bucket: deps.config.mailBucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
    }
    ContinuationToken = res.NextContinuationToken;
  } while (ContinuationToken);
}
