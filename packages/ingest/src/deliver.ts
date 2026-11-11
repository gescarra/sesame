// Delivers one raw message from S3 to every local mailbox among its envelope recipients.

import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { CopyObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { type DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  batchGet,
  buildIndex,
  type DeliveryJob,
  deliveredUlid,
  directoryKeys,
  getItem,
  htmlToSearchText,
  isMailboxFull,
  type MailboxItem,
  type MessageItem,
  mailKeys,
  messageObjectPrefix,
  type OutboundDelivery,
  resolveAddresses,
  type SearchIndex,
  type SystemFolder,
  UNDER_QUOTA_CONDITION,
  writeIndex,
} from "@sesame/core";
import PostalMime, { type Email } from "postal-mime";
import {
  type Body,
  buildBody,
  extractAttachments,
  makeSnippet,
  messageDate,
  normalizeSubject,
  parseMessageIds,
  type StoredAttachment,
  toAddresses,
} from "./message.ts";

export interface Deps {
  s3: S3Client;
  doc: DynamoDBDocumentClient;
  mailBucket: string;
  mailTable: string;
  directoryTable: string;
  /** Index body text for search (the largest share of index writes). Default true. */
  indexBody?: boolean;
  log: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

export type DeliveryOutcome = "delivered" | "duplicate" | "mailbox-missing" | "over-quota";

/**
 * Some recipients' mailboxes are full. The job fails so SQS retries it and then parks it in the DLQ,
 * where it waits for more space and a redrive. Mailboxes it already reached see the retry as a duplicate.
 */
export class MailboxFullError extends Error {
  constructor(readonly mailboxIds: string[]) {
    super(`mailbox full: ${mailboxIds.join(", ")}`);
    this.name = "MailboxFullError";
  }
}

export interface JobResult {
  dropped?: "virus" | "no-local-recipients";
  deliveries: { mailboxId: string; messageUlid: string; outcome: DeliveryOutcome; sent?: true }[];
}

export async function deliverJob(deps: Deps, job: DeliveryJob): Promise<JobResult> {
  const fields = { jobId: job.id, source: job.source };

  if (job.verdicts?.virus === "FAIL") {
    // Leave the landing copy for inspection; the raw/ lifecycle rule expires it.
    deps.log("warn", "dropping message with virus verdict FAIL", { ...fields, key: job.key });
    return { dropped: "virus", deliveries: [] };
  }

  const resolutions = await resolveAddresses(deps.doc, deps.directoryTable, job.recipients);
  for (const r of resolutions) {
    // Never bounce: bouncing spam to forged senders is backscatter.
    if (r.kind !== "local")
      deps.log("info", "ignoring non-local recipient", { ...fields, recipient: r.address, kind: r.kind });
  }
  const mailboxIds = [...new Set(resolutions.flatMap((r) => (r.kind === "local" ? [r.mailboxId] : [])))];
  if (mailboxIds.length === 0 && !job.sentCopy) return { dropped: "no-local-recipients", deliveries: [] };

  const obj = await deps.s3.send(new GetObjectCommand({ Bucket: job.bucket, Key: job.key }));
  if (!obj.Body) throw new Error(`empty S3 object ${job.bucket}/${job.key}`);
  const raw = await obj.Body.transformToByteArray();
  const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });

  const body = buildBody(email);
  const attachments = extractAttachments(email.attachments);
  const parsed: Parsed = {
    email,
    size: raw.byteLength,
    body,
    attachments,
    index: buildIndex({
      subject: normalizeSubject(email.subject),
      from: toAddresses(email.from)[0],
      to: toAddresses(email.to),
      cc: toAddresses(email.cc),
      attachmentNames: attachments.filter((a) => !a.meta.inline).map((a) => a.meta.filename),
      bodyText:
        deps.indexBody === false ? undefined : (email.text ?? (body.html ? htmlToSearchText(body.html) : "")),
    }),
  };
  const inboundFolder: SystemFolder = job.verdicts?.spam === "FAIL" ? "junk" : "inbox";

  const deliveries: JobResult["deliveries"] = [];
  for (const mailboxId of mailboxIds) {
    const messageUlid = deliveredUlid(job, mailboxId, "received");
    const outcome = await deliverToMailbox(deps, job, parsed, mailboxId, messageUlid, {
      folder: inboundFolder,
      read: false,
      enforceQuota: true,
    });
    deps.log(outcome === "over-quota" ? "warn" : "info", `delivery ${outcome}`, {
      ...fields,
      mailboxId,
      messageUlid,
    });
    deliveries.push({ mailboxId, messageUlid, outcome });
  }
  if (job.sentCopy) {
    const { mailboxId, delivery } = job.sentCopy;
    const messageUlid = deliveredUlid(job, mailboxId, "sent");
    // The API refuses to send from a full mailbox; a Sent copy that races past that still lands.
    const outcome = await deliverToMailbox(deps, job, parsed, mailboxId, messageUlid, {
      folder: "sent",
      read: true,
      delivery,
      enforceQuota: false,
    });
    deps.log("info", `sent copy ${outcome}`, { ...fields, mailboxId, messageUlid });
    deliveries.push({ mailboxId, messageUlid, outcome, sent: true });
  }
  const full = deliveries.filter((d) => d.outcome === "over-quota").map((d) => d.mailboxId);
  if (full.length) throw new MailboxFullError(full);
  return { deliveries };
}

interface Parsed {
  email: Email;
  size: number;
  body: Body;
  attachments: StoredAttachment[];
  index: SearchIndex;
}

interface Placement {
  folder: SystemFolder;
  read: boolean;
  delivery?: OutboundDelivery;
  enforceQuota: boolean;
}

async function deliverToMailbox(
  deps: Deps,
  job: DeliveryJob,
  parsed: Parsed,
  mailboxId: string,
  messageUlid: string,
  placement: Placement,
): Promise<DeliveryOutcome> {
  const key = mailKeys.message(mailboxId, messageUlid);

  // Cheap check so SQS redeliveries don't rewrite S3 objects.
  const existing = await deps.doc.send(
    new GetCommand({ TableName: deps.mailTable, Key: key, ProjectionExpression: "pk" }),
  );
  if (existing.Item) {
    // A redelivery may follow a crash between the transaction and the index writes.
    await writeIndex(deps.doc, deps.mailTable, mailboxId, messageUlid, parsed.index);
    return "duplicate";
  }
  if (placement.enforceQuota) {
    // Checked before writing objects, so a full mailbox doesn't collect orphans on every retry.
    const mailbox = await getItem<MailboxItem>(
      deps.doc,
      deps.directoryTable,
      directoryKeys.mailbox(mailboxId),
    );
    if (!mailbox) return missingMailbox(deps, job, mailboxId);
    if (isMailboxFull(mailbox)) return "over-quota";
  }

  const prefix = messageObjectPrefix(mailboxId, messageUlid);
  await Promise.all([
    deps.s3.send(
      new CopyObjectCommand({
        Bucket: deps.mailBucket,
        Key: `${prefix}message.eml`,
        CopySource: `${job.bucket}/${encodeURIComponent(job.key).replace(/%2F/g, "/")}`,
        ContentType: "message/rfc822",
        MetadataDirective: "REPLACE",
      }),
    ),
    deps.s3.send(
      new PutObjectCommand({
        Bucket: deps.mailBucket,
        Key: `${prefix}body.json`,
        Body: JSON.stringify(parsed.body),
        ContentType: "application/json",
      }),
    ),
    ...parsed.attachments.map((a) =>
      deps.s3.send(
        new PutObjectCommand({
          Bucket: deps.mailBucket,
          Key: `${prefix}att/${a.meta.partId}`,
          Body: a.content,
          ContentType: a.meta.contentType,
        }),
      ),
    ),
  ]);

  const { email } = parsed;
  const references = parseMessageIds(email.references, email.inReplyTo);
  const threadId = (await findThread(deps, mailboxId, references, email.inReplyTo)) ?? messageUlid;
  const messageIdHeader = email.messageId?.trim() || undefined;
  const attachments = parsed.attachments.map((a) => a.meta);

  const item: MessageItem = {
    ...key,
    ...mailKeys.folderView(mailboxId, placement.folder, messageUlid),
    ...mailKeys.threadView(mailboxId, threadId, messageUlid),
    type: "message",
    mailboxId,
    messageUlid,
    folder: placement.folder,
    threadId,
    to: toAddresses(email.to),
    cc: toAddresses(email.cc),
    subject: normalizeSubject(email.subject),
    snippet: makeSnippet(email.text, email.html),
    date: messageDate(email.date, job.receivedAt),
    receivedAt: job.receivedAt,
    size: parsed.size,
    read: placement.read,
    flagged: false,
    hasAttachments: attachments.some((a) => !a.inline),
    attachments,
    objectPrefix: prefix,
  };
  const from = toAddresses(email.from)[0];
  if (from) item.from = from;
  const replyTo = toAddresses(email.replyTo);
  if (replyTo.length) item.replyTo = replyTo;
  if (messageIdHeader) item.messageIdHeader = messageIdHeader;
  if (email.inReplyTo) item.inReplyTo = email.inReplyTo.trim();
  if (references.length) item.references = references;
  if (job.verdicts) item.auth = Object.fromEntries(Object.entries(job.verdicts).filter(([, v]) => v));
  if (placement.delivery) item.delivery = placement.delivery;
  if (parsed.index.size) item.tokens = [...parsed.index.keys()];

  const now = new Date().toISOString();
  try {
    await deps.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: deps.mailTable,
              Item: item,
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Update: {
              TableName: deps.mailTable,
              Key: mailKeys.folderCounter(mailboxId, placement.folder),
              // version tells phones waiting on the folder (ActiveSync Ping) that it changed.
              UpdateExpression: "ADD #total :one, #unread :unread, #version :one SET #updatedAt = :now",
              ExpressionAttributeNames: {
                "#total": "total",
                "#unread": "unread",
                "#version": "version",
                "#updatedAt": "updatedAt",
              },
              ExpressionAttributeValues: { ":one": 1, ":unread": placement.read ? 0 : 1, ":now": now },
            },
          },
          {
            Update: {
              TableName: deps.directoryTable,
              Key: directoryKeys.mailbox(mailboxId),
              UpdateExpression: "ADD #used :size",
              ConditionExpression: placement.enforceQuota
                ? `attribute_exists(pk) AND ${UNDER_QUOTA_CONDITION}`
                : "attribute_exists(pk)",
              ExpressionAttributeNames: { "#used": "usedBytes" },
              ExpressionAttributeValues: { ":size": parsed.size },
              ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            },
          },
          ...(messageIdHeader
            ? [
                {
                  Put: {
                    TableName: deps.mailTable,
                    Item: {
                      ...mailKeys.messageIdMap(mailboxId, messageIdHeader),
                      type: "message-id",
                      threadId,
                      messageUlid,
                    },
                  },
                },
              ]
            : []),
        ],
      }),
    );
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      const reasons = err.CancellationReasons ?? [];
      if (reasons[0]?.Code === "ConditionalCheckFailed") return "duplicate";
      if (reasons[2]?.Code === "ConditionalCheckFailed") {
        // The mailbox item came back, so it exists and filled up since the check above.
        return reasons[2].Item ? "over-quota" : missingMailbox(deps, job, mailboxId);
      }
    }
    throw err;
  }
  await writeIndex(deps.doc, deps.mailTable, mailboxId, messageUlid, parsed.index);
  return "delivered";
}

function missingMailbox(deps: Deps, job: DeliveryJob, mailboxId: string): DeliveryOutcome {
  // An address points at a mailbox that no longer exists. Retrying won't help.
  deps.log("error", "address resolves to a missing mailbox", { jobId: job.id, mailboxId });
  return "mailbox-missing";
}

/** Thread of the message this one replies to, if any message in its references is in the mailbox. */
async function findThread(
  deps: Deps,
  mailboxId: string,
  references: string[],
  inReplyTo: string | undefined,
): Promise<string | undefined> {
  if (references.length === 0) return undefined;
  const keys = references.map((id) => mailKeys.messageIdMap(mailboxId, id));
  const found = new Map(
    (await batchGet(deps.doc, deps.mailTable, keys)).map((i) => [i.sk as string, i.threadId as string]),
  );
  // Prefer the direct parent, then the most recent reference.
  const ordered = [...(inReplyTo ? parseMessageIds(inReplyTo) : []), ...references.toReversed()];
  for (const id of ordered) {
    const threadId = found.get(mailKeys.messageIdMap(mailboxId, id).sk);
    if (threadId) return threadId;
  }
  return undefined;
}
