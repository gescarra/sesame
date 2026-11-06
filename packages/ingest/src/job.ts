// Turns an SQS message body into a DeliveryJob.
//
// Two producers write to the ingest queue:
// - SES, through SNS with raw message delivery: the body is the SES "Received"
//   notification for an S3 receipt action. It carries the envelope recipients,
//   which the stored MIME does not (Bcc recipients only exist in the envelope).
// - The API, for internal delivery (M4): the body is a DeliveryJob with source "internal".
import type { DeliveryJob, Verdict } from "@sesame/core";

interface SesNotification {
  notificationType?: string;
  mail?: { messageId?: string; timestamp?: string };
  receipt?: {
    timestamp?: string;
    recipients?: string[];
    spamVerdict?: { status?: Verdict };
    virusVerdict?: { status?: Verdict };
    spfVerdict?: { status?: Verdict };
    dkimVerdict?: { status?: Verdict };
    dmarcVerdict?: { status?: Verdict };
    action?: { type?: string; bucketName?: string; objectKey?: string };
  };
}

export class InvalidJobError extends Error {}

/** Returns null for messages that should be acknowledged and ignored (e.g. SES setup notifications). */
export function parseJob(body: string): DeliveryJob | null {
  let msg: unknown;
  try {
    msg = JSON.parse(body);
  } catch {
    throw new InvalidJobError("body is not JSON");
  }
  if (typeof msg !== "object" || msg === null) throw new InvalidJobError("body is not an object");

  if ((msg as { source?: unknown }).source === "internal") return parseInternal(msg as DeliveryJob);

  const n = msg as SesNotification;
  if (n.notificationType !== "Received") return null;

  const action = n.receipt?.action;
  const id = n.mail?.messageId;
  const recipients = n.receipt?.recipients;
  if (action?.type !== "S3" || !action.bucketName || !action.objectKey || !id || !recipients?.length) {
    throw new InvalidJobError(`incomplete SES notification for ${id ?? "unknown message"}`);
  }

  return {
    source: "ses",
    id,
    bucket: action.bucketName,
    key: action.objectKey,
    recipients,
    receivedAt: n.receipt?.timestamp ?? n.mail?.timestamp ?? new Date().toISOString(),
    verdicts: {
      spam: n.receipt?.spamVerdict?.status,
      virus: n.receipt?.virusVerdict?.status,
      spf: n.receipt?.spfVerdict?.status,
      dkim: n.receipt?.dkimVerdict?.status,
      dmarc: n.receipt?.dmarcVerdict?.status,
    },
  };
}

function parseInternal(job: DeliveryJob): DeliveryJob {
  const hasRecipients = Array.isArray(job.recipients) && job.recipients.length > 0;
  const sentCopy = job.sentCopy;
  const validCopy =
    sentCopy && typeof sentCopy.mailboxId === "string" && typeof sentCopy.delivery === "object";
  if (!job.id || !job.bucket || !job.key || !job.receivedAt || !Array.isArray(job.recipients)) {
    throw new InvalidJobError(`incomplete internal job ${job.id ?? ""}`);
  }
  if (!hasRecipients && !validCopy)
    throw new InvalidJobError(`internal job ${job.id} has nothing to deliver`);
  const out: DeliveryJob = {
    source: "internal",
    id: job.id,
    bucket: job.bucket,
    key: job.key,
    recipients: job.recipients,
    // Required: message IDs derive from it, so a redelivery must see the same value.
    receivedAt: job.receivedAt,
  };
  if (validCopy) out.sentCopy = sentCopy;
  return out;
}
