// Updates the delivery state of a Sent copy. Shared by the sender and ses-events Lambdas.
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { type DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { isTerminal, overallStatus } from "./delivery.ts";
import { directoryKeys, mailKeys } from "./keys.ts";
import type { OutboundDelivery, RecipientDelivery, SuppressionItem } from "./types.ts";

/** The Sent copy isn't there yet: ingest files it asynchronously. Callers retry. */
export class SentCopyMissingError extends Error {}

/**
 * Whether a mailbox still exists. A missing Sent copy in a deleted mailbox will never appear, so
 * callers drop the update instead of retrying it into a dead-letter queue.
 */
export async function mailboxExists(
  doc: DynamoDBDocumentClient,
  directoryTable: string,
  mailboxId: string,
): Promise<boolean> {
  const res = await doc.send(
    new GetCommand({
      TableName: directoryTable,
      Key: directoryKeys.mailbox(mailboxId),
      ProjectionExpression: "pk",
    }),
  );
  return res.Item !== undefined;
}

/** Where SES events for a message should go. */
export interface SesMessageMapItem {
  pk: string;
  sk: string;
  type: "ses-message";
  mailboxId: string;
  sentUlid: string;
  ttl: number;
}

const MAP_TTL_SECONDS = 30 * 24 * 3600;

export async function putSesMessageMap(
  doc: DynamoDBDocumentClient,
  table: string,
  sesMessageId: string,
  target: { mailboxId: string; sentUlid: string },
  nowMs: number,
) {
  const item: SesMessageMapItem = {
    ...mailKeys.sesMessage(sesMessageId),
    type: "ses-message",
    ...target,
    ttl: Math.floor(nowMs / 1000) + MAP_TTL_SECONDS,
  };
  await doc.send(new PutCommand({ TableName: table, Item: item }));
}

/**
 * Merges per-recipient updates into the Sent copy's delivery state. A recipient that reached a
 * final state (delivered, bounced…) never goes back to sending/sent/delayed, so out-of-order SES
 * events can't undo a delivery. Concurrent writers are handled with an optimistic check.
 */
export async function updateRecipients(
  doc: DynamoDBDocumentClient,
  table: string,
  target: { mailboxId: string; sentUlid: string },
  updates: Record<string, RecipientDelivery>,
  opts: { sesMessageId?: string; nowMs: number },
): Promise<OutboundDelivery> {
  const key = mailKeys.message(target.mailboxId, target.sentUlid);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await doc.send(
      new GetCommand({
        TableName: table,
        Key: key,
        ConsistentRead: true,
        ProjectionExpression: "pk, delivery",
      }),
    );
    if (!res.Item)
      throw new SentCopyMissingError(`Sent copy ${target.mailboxId}/${target.sentUlid} not found`);
    const current = res.Item.delivery as OutboundDelivery | undefined;

    const recipients = { ...(current?.recipients ?? {}) };
    for (const [address, update] of Object.entries(updates)) {
      const prev = recipients[address];
      if (prev && isTerminal(prev.status) && !isTerminal(update.status)) continue;
      recipients[address] = update;
    }
    const next: OutboundDelivery = {
      status: overallStatus(recipients),
      recipients,
      updatedAt: new Date(opts.nowMs).toISOString(),
    };
    const sesMessageId = opts.sesMessageId ?? current?.sesMessageId;
    if (sesMessageId) next.sesMessageId = sesMessageId;

    try {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: key,
          UpdateExpression: "SET delivery = :next",
          ConditionExpression: current
            ? "attribute_exists(pk) AND delivery.updatedAt = :prev"
            : "attribute_exists(pk) AND attribute_not_exists(delivery)",
          ExpressionAttributeValues: current
            ? { ":next": next, ":prev": current.updatedAt }
            : { ":next": next },
        }),
      );
      return next;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) continue;
      throw err;
    }
  }
  throw new Error(`delivery state of ${target.sentUlid} kept changing; giving up for now`);
}

/** Records an address that bounced permanently or complained, so the API refuses to mail it again. */
export async function suppress(
  doc: DynamoDBDocumentClient,
  directoryTable: string,
  address: string,
  reason: SuppressionItem["reason"],
  detail: string | undefined,
  nowMs: number,
) {
  const item: SuppressionItem = {
    ...directoryKeys.suppression(address),
    type: "suppression",
    address: address.toLowerCase(),
    reason,
    at: new Date(nowMs).toISOString(),
  };
  if (detail) item.detail = detail.slice(0, 1000);
  await doc.send(new PutCommand({ TableName: directoryTable, Item: item }));
}
