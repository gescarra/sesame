// Applies SES configuration-set events to the Sent copy they belong to.
//
// The events arrive through SNS and SQS (raw message delivery), so each body is one SES event.
// The sender maps SES message IDs to Sent copies right after sending. An event that arrives
// before that mapping, or before ingest files the Sent copy, fails and is retried by SQS.
import { type DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  mailboxExists,
  mailKeys,
  type RecipientDelivery,
  SentCopyMissingError,
  type SesMessageMapItem,
  type SuppressionItem,
  suppress,
  updateRecipients,
} from "@sesame/core";

export interface Deps {
  doc: DynamoDBDocumentClient;
  mailTable: string;
  directoryTable: string;
  now: () => number;
  log: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

interface Recipient {
  emailAddress?: string;
  diagnosticCode?: string;
}

export interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; destination?: string[]; timestamp?: string };
  send?: object;
  delivery?: { recipients?: string[]; timestamp?: string; smtpResponse?: string };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: Recipient[];
    timestamp?: string;
  };
  complaint?: { complainedRecipients?: Recipient[]; complaintFeedbackType?: string; timestamp?: string };
  deliveryDelay?: { delayedRecipients?: Recipient[]; delayType?: string; timestamp?: string };
  reject?: { reason?: string };
  failure?: { errorMessage?: string };
}

export interface EventEffect {
  sesMessageId: string;
  updates: Record<string, RecipientDelivery>;
  suppressions: { address: string; reason: SuppressionItem["reason"]; detail?: string }[];
}

export class InvalidEventError extends Error {}

const norm = (a: string) => a.trim().toLowerCase();

function each(
  recipients: Recipient[] | undefined,
  status: RecipientDelivery["status"],
  at: string,
  fallback?: string,
) {
  const out: Record<string, RecipientDelivery> = {};
  for (const r of recipients ?? []) {
    if (!r.emailAddress) continue;
    const detail = r.diagnosticCode ?? fallback;
    out[norm(r.emailAddress)] = detail ? { status, detail, at } : { status, at };
  }
  return out;
}

/** What an event means for each recipient. Null for events sesame doesn't track (opens, clicks…). */
export function eventEffect(event: SesEvent, nowIso: string): EventEffect | null {
  const type = event.eventType ?? event.notificationType;
  const sesMessageId = event.mail?.messageId;
  if (!type) throw new InvalidEventError("event has no type");
  if (!sesMessageId) throw new InvalidEventError(`${type} event has no message ID`);
  const all = (event.mail?.destination ?? []).map((a) => ({ emailAddress: a }));
  const effect: EventEffect = { sesMessageId, updates: {}, suppressions: [] };

  switch (type) {
    case "Send":
      effect.updates = each(all, "sent", event.mail?.timestamp ?? nowIso);
      break;
    case "Delivery": {
      const at = event.delivery?.timestamp ?? nowIso;
      effect.updates = each(
        (event.delivery?.recipients ?? []).map((a) => ({ emailAddress: a })),
        "delivered",
        at,
        event.delivery?.smtpResponse,
      );
      break;
    }
    case "Bounce": {
      const b = event.bounce;
      const permanent = b?.bounceType === "Permanent";
      const fallback = [b?.bounceType, b?.bounceSubType].filter(Boolean).join(" / ");
      effect.updates = each(b?.bouncedRecipients, "bounced", b?.timestamp ?? nowIso, fallback);
      // Only hard bounces block the address; transient ones may succeed next time.
      if (permanent) {
        for (const [address, u] of Object.entries(effect.updates)) {
          effect.suppressions.push(
            u.detail ? { address, reason: "bounce", detail: u.detail } : { address, reason: "bounce" },
          );
        }
      }
      break;
    }
    case "Complaint": {
      const c = event.complaint;
      effect.updates = each(
        c?.complainedRecipients,
        "complained",
        c?.timestamp ?? nowIso,
        c?.complaintFeedbackType,
      );
      for (const address of Object.keys(effect.updates))
        effect.suppressions.push({ address, reason: "complaint" });
      break;
    }
    case "DeliveryDelay": {
      const d = event.deliveryDelay;
      effect.updates = each(d?.delayedRecipients, "delayed", d?.timestamp ?? nowIso, d?.delayType);
      break;
    }
    case "Reject":
      effect.updates = each(all, "rejected", nowIso, event.reject?.reason);
      break;
    case "Rendering Failure":
    case "RenderingFailure":
      effect.updates = each(all, "failed", nowIso, event.failure?.errorMessage);
      break;
    default:
      return null;
  }
  return effect;
}

export async function handleEvent(deps: Deps, body: string): Promise<"applied" | "ignored"> {
  let event: SesEvent;
  try {
    event = JSON.parse(body);
  } catch {
    throw new InvalidEventError("body is not JSON");
  }
  const nowMs = deps.now();
  const effect = eventEffect(event, new Date(nowMs).toISOString());
  if (!effect || Object.keys(effect.updates).length === 0) return "ignored";

  for (const s of effect.suppressions) {
    await suppress(deps.doc, deps.directoryTable, s.address, s.reason, s.detail, nowMs);
    deps.log("warn", "address suppressed", { address: s.address, reason: s.reason });
  }

  const map = (
    await deps.doc.send(
      new GetCommand({ TableName: deps.mailTable, Key: mailKeys.sesMessage(effect.sesMessageId) }),
    )
  ).Item as SesMessageMapItem | undefined;
  if (!map) throw new Error(`no Sent copy recorded for SES message ${effect.sesMessageId} yet`);

  let delivery: Awaited<ReturnType<typeof updateRecipients>>;
  try {
    delivery = await updateRecipients(
      deps.doc,
      deps.mailTable,
      { mailboxId: map.mailboxId, sentUlid: map.sentUlid },
      effect.updates,
      { nowMs },
    );
  } catch (err) {
    if (
      !(err instanceof SentCopyMissingError) ||
      (await mailboxExists(deps.doc, deps.directoryTable, map.mailboxId))
    )
      throw err;
    deps.log("info", "dropping event for a deleted mailbox", {
      sesMessageId: effect.sesMessageId,
      mailboxId: map.mailboxId,
    });
    return "ignored";
  }
  deps.log("info", "delivery updated", {
    sesMessageId: effect.sesMessageId,
    event: event.eventType ?? event.notificationType,
    status: delivery.status,
  });
  return "applied";
}
