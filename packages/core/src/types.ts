// Shapes of items stored in DynamoDB and of jobs on the ingest queue.
import type { SystemFolder } from "./folders.ts";

export interface DomainItem {
  pk: string;
  sk: string;
  type: "domain";
  domain: string;
  /** Mailbox that receives mail for unknown addresses at this domain. */
  catchAllMailboxId?: string;
  createdAt: string;
}

export interface AddressItem {
  pk: string;
  sk: string;
  type: "address";
  address: string;
  mailboxId: string;
  kind: "primary" | "alias";
  createdAt: string;
}

export interface MailboxItem {
  pk: string;
  sk: string;
  type: "mailbox";
  mailboxId: string;
  primaryAddress: string;
  displayName?: string;
  quotaBytes?: number;
  usedBytes?: number;
  createdAt: string;
}

export interface MemberItem {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  type: "member";
  mailboxId: string;
  /** Normalized email claim of the signed-in user. */
  userId: string;
  role: "owner" | "delegate";
  createdAt: string;
}

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface AttachmentMeta {
  partId: string;
  filename: string;
  contentType: string;
  size: number;
  /** Set for inline parts referenced from the HTML body as cid:… */
  contentId?: string;
  inline: boolean;
}

export type Verdict = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED" | "DISABLED";

export interface MessageItem {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  gsi2pk: string;
  gsi2sk: string;
  gsi3pk?: string;
  gsi3sk?: string;
  type: "message";
  mailboxId: string;
  messageUlid: string;
  folder: SystemFolder;
  threadId: string;
  from?: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo?: EmailAddress[];
  subject: string;
  snippet: string;
  /** Date header, or the receive time when missing or unparseable. ISO 8601. */
  date: string;
  receivedAt: string;
  size: number;
  read: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  attachments: AttachmentMeta[];
  messageIdHeader?: string;
  inReplyTo?: string;
  references?: string[];
  /** S3 key prefix holding message.eml, body.json and att/{partId}. */
  objectPrefix: string;
  auth?: { spf?: Verdict; dkim?: Verdict; dmarc?: Verdict; spam?: Verdict; virus?: Verdict };
  /** Only on Sent copies: where the message got to, per recipient. */
  delivery?: OutboundDelivery;
  /** Search tokens written for this message, so purging can delete them. */
  tokens?: string[];
}

/**
 * Lifecycle of one outbound recipient. Internal recipients go straight to "delivered";
 * external ones move through SES: sending -> sent -> delivered | delayed | bounced | complained.
 * "rejected" is SES refusing the message (e.g. a virus); "failed" is the sender giving up.
 */
export type DeliveryStatus =
  | "sending"
  | "sent"
  | "delivered"
  | "delayed"
  | "bounced"
  | "complained"
  | "rejected"
  | "failed";

export interface RecipientDelivery {
  status: DeliveryStatus;
  /** SES diagnostic, e.g. the remote server's bounce reply. */
  detail?: string;
  at: string;
}

export interface OutboundDelivery {
  /** The worst recipient status; see overallStatus(). */
  status: DeliveryStatus;
  /** Keyed by normalized address. */
  recipients: Record<string, RecipientDelivery>;
  sesMessageId?: string;
  updatedAt: string;
}

/**
 * A raw message waiting in S3 to be delivered to local mailboxes.
 * Produced by SES (inbound) or by the API (internal delivery and Sent copies).
 */
export interface DeliveryJob {
  source: "ses" | "internal";
  /** Unique per message; seeds deterministic message IDs. */
  id: string;
  bucket: string;
  key: string;
  /** Envelope recipients. Bcc recipients only appear here. May be empty when only sentCopy is set. */
  recipients: string[];
  receivedAt: string;
  verdicts?: MessageItem["auth"];
  /** Also file the message, read, in this mailbox's Sent folder with this delivery state. */
  sentCopy?: { mailboxId: string; delivery: OutboundDelivery };
}

/** One outbound message for the sender Lambda: send `key` from S3 to the external `destinations`. */
export interface SendJob {
  id: string;
  bucket: string;
  key: string;
  /** Envelope sender, a primary address or alias of mailboxId. */
  from: string;
  destinations: string[];
  /** The sending mailbox and its Sent copy, for status updates. */
  mailboxId: string;
  sentUlid: string;
}

export interface SuppressionItem {
  pk: string;
  sk: string;
  type: "suppression";
  address: string;
  reason: "bounce" | "complaint";
  detail?: string;
  at: string;
}

/** A deleted mailbox whose mail the purge Lambda is still removing. */
export interface PurgeItem {
  pk: string;
  sk: string;
  type: "purge";
  mailboxId: string;
  /** The mailbox's primary address, for display; it may already belong to a new mailbox. */
  address: string;
  requestedBy: string;
  requestedAt: string;
}

/**
 * A password for one mailbox, used by ActiveSync clients (phones), which can't sign in through
 * Cognito. Only the SHA-256 of the normalized password is stored; see appPassword.ts.
 */
export interface AppPasswordItem {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  type: "app-password";
  id: string;
  /** Normalized email of the user who created it; mailbox access is re-checked on every use. */
  userId: string;
  mailboxId: string;
  label: string;
  createdAt: string;
  /** Updated at most hourly. */
  lastUsedAt?: string;
}

/** An ActiveSync device, created on its first signed-in request. */
export interface DeviceItem {
  pk: string;
  sk: string;
  type: "device";
  userId: string;
  deviceId: string;
  deviceType: string;
  /** The app password it last signed in with, and that password's mailbox. */
  passwordId: string;
  mailboxId: string;
  userAgent?: string;
  model?: string;
  os?: string;
  friendlyName?: string;
  /** Set by the second Provision round; every other command must present it. */
  policyKey?: string;
  /** Handed out in the first Provision round, waiting for the client's acknowledgement. */
  pendingPolicyKey?: string;
  firstSeenAt: string;
  /** Updated at most hourly. */
  lastSeenAt: string;
}

/** Message on the purge queue. The final pass runs later, to catch deliveries already in flight. */
export interface PurgeJob {
  mailboxId: string;
  final?: boolean;
}
