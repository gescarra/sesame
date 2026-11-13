// Routes an outgoing message, wherever it was written: the web app builds MIME from a form, a
// phone sends its own over ActiveSync. Both come here for the same checks and the same routing:
// - internal recipients and the sender's Sent copy go to the ingest queue, like inbound mail;
// - external recipients go to the send queue, where the sender Lambda hands them to SES.
// No mail between local mailboxes ever goes through SES.
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { type DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { normalizeAddress } from "./address.ts";
import { newDelivery } from "./delivery.ts";
import { batchGet, getItem, resolveAddresses } from "./directory.ts";
import { deliveredUlid, newUlid } from "./ids.ts";
import { directoryKeys } from "./keys.ts";
import { isMailboxFull } from "./quota.ts";
import type { DeliveryJob, MailboxItem, SendJob } from "./types.ts";

/** SES v2 accepts up to 50 recipients per message. */
export const MAX_RECIPIENTS = 50;

export interface OutgoingDeps {
  doc: DynamoDBDocumentClient;
  s3: S3Client;
  sqs: SQSClient;
  config: {
    directoryTable: string;
    mailBucket: string;
    ingestQueueUrl: string;
    sendQueueUrl: string;
    /** Messages one person may send per hour, from the web app and phones together. */
    sendRateLimit: number;
  };
  now: () => number;
  log: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

export type OutgoingErrorCode =
  | "no-recipients"
  | "too-many-recipients"
  | "mailbox-not-found"
  | "bad-from"
  | "unknown-recipient"
  | "mailbox-full"
  | "recipient-full"
  | "suppressed"
  | "rate-limited";

/** A message sesame refuses to send. The message is meant for the sender. */
export class OutgoingError extends Error {
  constructor(
    readonly code: OutgoingErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface OutgoingRequest {
  mailboxId: string;
  /** The sender's normalized email: the rate limit is per person, not per app. */
  userId: string;
  /** Defaults to the mailbox's primary address. Must be one of the mailbox's own addresses. */
  from?: string;
  /** Send from the primary address when `from` isn't the mailbox's own, instead of refusing. */
  fallbackFrom?: boolean;
  /** Every envelope recipient: To, Cc and Bcc. */
  recipients: string[];
  /**
   * Builds the MIME once every check has passed and before the rate token is taken, so a
   * message that can't be built costs nothing. It may throw its own errors.
   */
  compose: (c: { id: string; date: Date; from: string; mailbox: MailboxItem }) => Promise<Buffer>;
}

export interface OutgoingResult {
  id: string;
  /** The Sent copy ingest will file. */
  sentUlid: string;
  internal: number;
  external: number;
}

export async function queueOutgoing(deps: OutgoingDeps, req: OutgoingRequest): Promise<OutgoingResult> {
  const { config } = deps;
  const recipients = [...new Set(req.recipients.map(normalizeAddress))];
  if (recipients.length === 0) throw new OutgoingError("no-recipients", "add at least one recipient");
  if (recipients.length > MAX_RECIPIENTS) {
    throw new OutgoingError("too-many-recipients", `at most ${MAX_RECIPIENTS} recipients per message`);
  }
  const mailbox = await getItem<MailboxItem>(
    deps.doc,
    config.directoryTable,
    directoryKeys.mailbox(req.mailboxId),
  );
  if (!mailbox) throw new OutgoingError("mailbox-not-found", "mailbox not found");

  const [fromResolution, ...resolutions] = await resolveAddresses(deps.doc, config.directoryTable, [
    req.from ?? mailbox.primaryAddress,
    ...recipients,
  ]);
  // The From address must be this mailbox's own (primary or alias), never a catch-all match.
  const ownFrom =
    fromResolution?.kind === "local" &&
    fromResolution.mailboxId === req.mailboxId &&
    fromResolution.via === "address";
  if (!ownFrom && !req.fallbackFrom) {
    throw new OutgoingError("bad-from", "you can only send from this mailbox's own addresses");
  }
  const from = ownFrom ? fromResolution.address : normalizeAddress(mailbox.primaryAddress);

  const unknown = resolutions.filter((r) => r.kind === "unknown-local").map((r) => r.address);
  if (unknown.length) {
    throw new OutgoingError("unknown-recipient", `no mailbox exists for ${unknown.join(", ")}`);
  }
  const local = resolutions.flatMap((r) => (r.kind === "local" ? [r] : []));
  const internal = local.map((r) => r.address);
  const external = resolutions.filter((r) => r.kind === "external").map((r) => r.address);

  // Ingest would hold mail for a full mailbox in the DLQ; refusing here tells the sender right away.
  if (isMailboxFull(mailbox)) {
    throw new OutgoingError(
      "mailbox-full",
      "your mailbox is full: delete mail from Trash, or ask your administrator for more space",
    );
  }
  if (local.length) {
    const boxes = (await batchGet(
      deps.doc,
      config.directoryTable,
      [...new Set(local.map((r) => r.mailboxId))].map((id) => directoryKeys.mailbox(id)),
    )) as unknown as MailboxItem[];
    const full = new Set(boxes.filter(isMailboxFull).map((b) => b.mailboxId));
    const blocked = local.filter((r) => full.has(r.mailboxId)).map((r) => r.address);
    if (blocked.length) {
      throw new OutgoingError("recipient-full", `not sent: the mailbox of ${blocked.join(", ")} is full`);
    }
  }
  if (external.length) {
    const suppressed = await batchGet(
      deps.doc,
      config.directoryTable,
      external.map((a) => directoryKeys.suppression(a)),
    );
    if (suppressed.length) {
      const list = suppressed.map((s) => `${s.address} (${s.reason})`).join(", ");
      throw new OutgoingError(
        "suppressed",
        `not sent: earlier mail to ${list} failed, so these addresses are blocked`,
      );
    }
  }

  const date = new Date(deps.now());
  const id = newUlid(date.getTime());
  const raw = await req.compose({ id, date, from, mailbox });
  await takeRateToken(deps, req.userId);

  const key = `raw/outbound/${id}.eml`;
  await deps.s3.send(
    new PutObjectCommand({ Bucket: config.mailBucket, Key: key, Body: raw, ContentType: "message/rfc822" }),
  );

  const receivedAt = date.toISOString();
  const job: DeliveryJob = {
    source: "internal",
    id,
    bucket: config.mailBucket,
    key,
    recipients: internal,
    receivedAt,
    sentCopy: { mailboxId: req.mailboxId, delivery: newDelivery(external, internal, receivedAt) },
  };
  const sentUlid = deliveredUlid(job, req.mailboxId, "sent");
  await deps.sqs.send(
    new SendMessageCommand({ QueueUrl: config.ingestQueueUrl, MessageBody: JSON.stringify(job) }),
  );
  if (external.length) {
    const sendJob: SendJob = {
      id,
      bucket: config.mailBucket,
      key,
      from,
      destinations: external,
      mailboxId: req.mailboxId,
      sentUlid,
    };
    await deps.sqs.send(
      new SendMessageCommand({ QueueUrl: config.sendQueueUrl, MessageBody: JSON.stringify(sendJob) }),
    );
  }

  deps.log("info", "message queued", {
    id,
    mailboxId: req.mailboxId,
    internal: internal.length,
    external: external.length,
  });
  return { id, sentUlid, internal: internal.length, external: external.length };
}

/** Counts sends per person per clock hour; the item expires a day later. */
async function takeRateToken(deps: OutgoingDeps, userId: string) {
  const now = new Date(deps.now());
  const window = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  try {
    await deps.doc.send(
      new UpdateCommand({
        TableName: deps.config.directoryTable,
        Key: directoryKeys.rate(userId, window),
        UpdateExpression: "ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
        ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":one": 1,
          ":limit": deps.config.sendRateLimit,
          ":ttl": Math.floor(now.getTime() / 1000) + 24 * 3600,
        },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new OutgoingError(
        "rate-limited",
        `you can send at most ${deps.config.sendRateLimit} messages an hour`,
      );
    }
    throw err;
  }
}
