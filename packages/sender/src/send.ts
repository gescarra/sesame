// Sends one stored message to its external recipients through SES, at most once.
//
// The job's lock item is claimed before calling SES and records the SES message ID afterwards.
// A redelivered job therefore never sends again. If it finds a lock with an ID, it only
// finishes the bookkeeping. If it finds a lock without one, the previous attempt died at an
// unknown point; the recipients are marked failed instead of risking a duplicate.
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { type SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  isValidAddress,
  mailboxExists,
  mailKeys,
  putSesMessageMap,
  type RecipientDelivery,
  type SendJob,
  SentCopyMissingError,
  updateRecipients,
} from "@sesame/core";

export interface Deps {
  s3: S3Client;
  ses: SESv2Client;
  doc: DynamoDBDocumentClient;
  mailTable: string;
  /** To tell a Sent copy that isn't filed yet from one whose mailbox was deleted. */
  directoryTable: string;
  configurationSet: string;
  now: () => number;
  log: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

export class InvalidSendJobError extends Error {}

export function parseSendJob(body: string): SendJob {
  let job: Partial<SendJob>;
  try {
    job = JSON.parse(body);
  } catch {
    throw new InvalidSendJobError("body is not JSON");
  }
  const ok =
    typeof job.id === "string" &&
    typeof job.bucket === "string" &&
    typeof job.key === "string" &&
    typeof job.from === "string" &&
    isValidAddress(job.from) &&
    typeof job.mailboxId === "string" &&
    typeof job.sentUlid === "string" &&
    Array.isArray(job.destinations) &&
    job.destinations.length > 0 &&
    job.destinations.length <= 50 &&
    job.destinations.every((d) => typeof d === "string" && isValidAddress(d));
  if (!ok) throw new InvalidSendJobError(`incomplete send job ${job.id ?? ""}`);
  return job as SendJob;
}

/** SES errors that a later attempt can succeed past. Everything else fails the message. */
const RETRYABLE = new Set([
  "TooManyRequestsException",
  "LimitExceededException",
  "InternalFailure",
  "ServiceUnavailable",
]);

function isRetryable(err: unknown): boolean {
  const e = err as { name?: string; $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
  if (e.name && RETRYABLE.has(e.name)) return true;
  if (e.$retryable) return true;
  const status = e.$metadata?.httpStatusCode;
  return status === undefined || status >= 500;
}

const LOCK_TTL_SECONDS = 14 * 24 * 3600;

export type SendOutcome = "sent" | "already-sent" | "failed";

export async function sendJob(deps: Deps, job: SendJob): Promise<SendOutcome> {
  const fields = { jobId: job.id, mailboxId: job.mailboxId, recipients: job.destinations.length };
  const lockKey = mailKeys.sendLock(job.id);
  const nowMs = deps.now();

  try {
    await deps.doc.send(
      new PutCommand({
        TableName: deps.mailTable,
        Item: {
          ...lockKey,
          type: "send-lock",
          status: "sending",
          startedAt: new Date(nowMs).toISOString(),
          ttl: Math.floor(nowMs / 1000) + LOCK_TTL_SECONDS,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    const lock = (
      await deps.doc.send(new GetCommand({ TableName: deps.mailTable, Key: lockKey, ConsistentRead: true }))
    ).Item;
    if (typeof lock?.sesMessageId === "string") {
      await recordSent(deps, job, lock.sesMessageId);
      return "already-sent";
    }
    if (lock?.status === "failed") return "failed";
    deps.log("warn", "previous send attempt was interrupted; not resending", fields);
    await markFailed(
      deps,
      job,
      "Sending was interrupted and may not have happened. Send the message again if needed.",
    );
    await setLock(deps, job, { status: "failed" });
    return "failed";
  }

  const object = await deps.s3.send(new GetObjectCommand({ Bucket: job.bucket, Key: job.key }));
  const raw = await object.Body?.transformToByteArray();
  if (!raw) throw new Error(`empty object ${job.bucket}/${job.key}`);

  let sesMessageId: string;
  try {
    const res = await deps.ses.send(
      new SendEmailCommand({
        FromEmailAddress: job.from,
        Destination: { ToAddresses: job.destinations },
        Content: { Raw: { Data: raw } },
        ConfigurationSetName: deps.configurationSet,
      }),
    );
    if (!res.MessageId) throw new Error("SES returned no MessageId");
    sesMessageId = res.MessageId;
  } catch (err) {
    if (isRetryable(err)) {
      // Nothing was sent: release the lock so the SQS retry can try again.
      await deps.doc.send(new DeleteCommand({ TableName: deps.mailTable, Key: lockKey }));
      throw err;
    }
    const detail = (err as Error).message || String(err);
    deps.log("error", "SES refused the message", { ...fields, error: detail, name: (err as Error).name });
    await setLock(deps, job, { status: "failed" });
    await markFailed(deps, job, detail);
    return "failed";
  }

  await setLock(deps, job, { status: "sent", sesMessageId });
  await recordSent(deps, job, sesMessageId);
  deps.log("info", "sent through SES", { ...fields, sesMessageId });
  return "sent";
}

async function setLock(deps: Deps, job: SendJob, values: { status: string; sesMessageId?: string }) {
  const names: Record<string, string> = { "#status": "status" };
  const vals: Record<string, unknown> = { ":status": values.status };
  let expr = "SET #status = :status";
  if (values.sesMessageId) {
    expr += ", sesMessageId = :id";
    vals[":id"] = values.sesMessageId;
  }
  await deps.doc.send(
    new UpdateCommand({
      TableName: deps.mailTable,
      Key: mailKeys.sendLock(job.id),
      UpdateExpression: expr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: vals,
    }),
  );
}

/** Points SES events at the Sent copy and marks the recipients sent. */
/**
 * Updates the Sent copy. Mail sent just before its mailbox was deleted still goes out, but its
 * Sent copy is gone for good, so the update is dropped rather than retried.
 */
async function updateSentCopy(
  deps: Deps,
  job: SendJob,
  updates: Record<string, RecipientDelivery>,
  opts: { sesMessageId?: string; nowMs: number },
) {
  try {
    await updateRecipients(
      deps.doc,
      deps.mailTable,
      { mailboxId: job.mailboxId, sentUlid: job.sentUlid },
      updates,
      opts,
    );
  } catch (err) {
    if (
      !(err instanceof SentCopyMissingError) ||
      (await mailboxExists(deps.doc, deps.directoryTable, job.mailboxId))
    )
      throw err;
    deps.log("info", "mailbox was deleted; not recording delivery", {
      jobId: job.id,
      mailboxId: job.mailboxId,
    });
  }
}

async function recordSent(deps: Deps, job: SendJob, sesMessageId: string) {
  const nowMs = deps.now();
  const target = { mailboxId: job.mailboxId, sentUlid: job.sentUlid };
  await putSesMessageMap(deps.doc, deps.mailTable, sesMessageId, target, nowMs);
  const at = new Date(nowMs).toISOString();
  const updates: Record<string, RecipientDelivery> = {};
  for (const d of job.destinations) updates[d] = { status: "sent", at };
  await updateSentCopy(deps, job, updates, { sesMessageId, nowMs });
}

async function markFailed(deps: Deps, job: SendJob, detail: string) {
  const at = new Date(deps.now()).toISOString();
  const updates: Record<string, RecipientDelivery> = {};
  for (const d of job.destinations) updates[d] = { status: "failed", detail, at };
  await updateSentCopy(deps, job, updates, { nowMs: deps.now() });
}
