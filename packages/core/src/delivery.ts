// Outbound delivery status helpers. No imports beyond types, so the SPA can use them too.
import type { DeliveryStatus, OutboundDelivery, RecipientDelivery } from "./types.ts";

/** Worst first: one bounce makes the whole message "bounced", even if others were delivered. */
const SEVERITY: DeliveryStatus[] = [
  "bounced",
  "rejected",
  "failed",
  "complained",
  "delayed",
  "sending",
  "sent",
  "delivered",
];

export function overallStatus(recipients: Record<string, RecipientDelivery>): DeliveryStatus {
  let worst = SEVERITY.length - 1;
  for (const r of Object.values(recipients)) worst = Math.min(worst, SEVERITY.indexOf(r.status));
  return SEVERITY[worst] ?? "delivered";
}

/** Statuses SES can still move on from; terminal ones never go back to these. */
export function isTerminal(status: DeliveryStatus): boolean {
  return status !== "sending" && status !== "sent" && status !== "delayed";
}

export function newDelivery(external: string[], internal: string[], at: string): OutboundDelivery {
  const recipients: Record<string, RecipientDelivery> = {};
  for (const a of internal) recipients[a] = { status: "delivered", at };
  for (const a of external) recipients[a] = { status: "sending", at };
  return { status: overallStatus(recipients), recipients, updatedAt: at };
}
