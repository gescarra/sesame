// State changes to stored messages, shared by the API and ActiveSync: read, flag and folder
// changes with their folder counter deltas, and deletion. Callers map the errors to their protocol.
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { MessageChanges } from "./dto.ts";
import type { SystemFolder } from "./folders.ts";
import { directoryKeys, mailKeys } from "./keys.ts";
import { deleteIndex } from "./search.ts";
import type { MessageItem } from "./types.ts";

/** What message changes need. The API's and ActiveSync's dependencies both fit. */
export interface MessageStore {
  doc: DynamoDBDocumentClient;
  s3: S3Client;
  config: { mailTable: string; directoryTable: string; mailBucket: string };
  now: () => number;
  log: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

export class MessageNotFoundError extends Error {
  constructor() {
    super("message not found");
  }
}

/** The message kept changing under three attempts, or changed between the read and the delete. */
export class MessageConflictError extends Error {
  constructor() {
    super("message changed concurrently, try again");
  }
}

export async function findMessage(
  store: Pick<MessageStore, "doc" | "config">,
  mailboxId: string,
  id: string,
  consistent = false,
): Promise<MessageItem | undefined> {
  const res = await store.doc.send(
    new GetCommand({
      TableName: store.config.mailTable,
      Key: mailKeys.message(mailboxId, id),
      ConsistentRead: consistent,
    }),
  );
  return res.Item as MessageItem | undefined;
}

async function mustFindMessage(store: MessageStore, mailboxId: string, id: string) {
  const message = await findMessage(store, mailboxId, id, true);
  if (!message) throw new MessageNotFoundError();
  return message;
}

function isConditionFailure(err: unknown): boolean {
  return (
    err instanceof TransactionCanceledException &&
    err.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"
  );
}

/**
 * Applies read/flag/folder changes and the matching counter deltas in one transaction.
 * The update is conditional on the state it was computed from; on a race it re-reads and retries.
 */
export async function changeMessage(
  store: MessageStore,
  mailboxId: string,
  id: string,
  changes: MessageChanges,
): Promise<MessageItem> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await mustFindMessage(store, mailboxId, id);
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
        TableName: store.config.mailTable,
        Key: mailKeys.folderCounter(mailboxId, folder),
        UpdateExpression: "ADD #total :total, #unread :unread SET #updatedAt = :now",
        ExpressionAttributeNames: { "#total": "total", "#unread": "unread", "#updatedAt": "updatedAt" },
        ExpressionAttributeValues: {
          ":total": total,
          ":unread": unread,
          ":now": new Date(store.now()).toISOString(),
        },
      },
    }));

    try {
      await store.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: store.config.mailTable,
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
      if (isConditionFailure(err)) continue;
      throw err;
    }
    return { ...cur, ...next, gsi1pk: values[":gsi1pk"] as string };
  }
  throw new MessageConflictError();
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
export async function removeMessage(
  store: MessageStore,
  mailboxId: string,
  id: string,
): Promise<"trashed" | "purged"> {
  const cur = await mustFindMessage(store, mailboxId, id);
  if (cur.folder !== "trash") {
    await changeMessage(store, mailboxId, id, { folder: "trash" });
    return "trashed";
  }
  try {
    await store.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: store.config.mailTable,
              Key: mailKeys.message(mailboxId, id),
              ConditionExpression: "#folder = :trash",
              ExpressionAttributeNames: { "#folder": "folder" },
              ExpressionAttributeValues: { ":trash": "trash" },
            },
          },
          {
            Update: {
              TableName: store.config.mailTable,
              Key: mailKeys.folderCounter(mailboxId, "trash"),
              UpdateExpression: "ADD #total :total, #unread :unread",
              ExpressionAttributeNames: { "#total": "total", "#unread": "unread" },
              ExpressionAttributeValues: { ":total": -1, ":unread": cur.read ? 0 : -1 },
            },
          },
          {
            Update: {
              TableName: store.config.directoryTable,
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
    if (isConditionFailure(err)) throw new MessageConflictError();
    throw err;
  }

  // Best effort after the item is gone: a leftover map entry or object is harmless.
  if (cur.messageIdHeader) {
    await store.doc
      .send(
        new DeleteCommand({
          TableName: store.config.mailTable,
          Key: mailKeys.messageIdMap(mailboxId, cur.messageIdHeader),
          ConditionExpression: "messageUlid = :u",
          ExpressionAttributeValues: { ":u": id },
        }),
      )
      .catch(() => undefined);
  }
  if (cur.tokens?.length) {
    await deleteIndex(store.doc, store.config.mailTable, mailboxId, id, cur.tokens).catch((err) =>
      store.log("warn", "could not delete search tokens", { id, error: String(err) }),
    );
  }
  await deleteObjects(store, cur.objectPrefix).catch((err) =>
    store.log("warn", "could not delete message objects", { prefix: cur.objectPrefix, error: String(err) }),
  );
  return "purged";
}

async function deleteObjects(store: MessageStore, prefix: string) {
  let ContinuationToken: string | undefined;
  do {
    const res = await store.s3.send(
      new ListObjectsV2Command({ Bucket: store.config.mailBucket, Prefix: prefix, ContinuationToken }),
    );
    const objects = (res.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (objects.length) {
      await store.s3.send(
        new DeleteObjectsCommand({
          Bucket: store.config.mailBucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
    }
    ContinuationToken = res.NextContinuationToken;
  } while (ContinuationToken);
}
