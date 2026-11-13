// Shapes of HTTP API responses, shared by the API and the SPA.
// Browser-safe: imports types only, and only from modules without Node dependencies.
import type { SystemFolder } from "./folders.ts";
import type { AttachmentMeta, DeliveryStatus, EmailAddress, OutboundDelivery, Verdict } from "./types.ts";

export type { SystemFolder } from "./folders.ts";
export type {
  AttachmentMeta,
  DeliveryStatus,
  EmailAddress,
  OutboundDelivery,
  RecipientDelivery,
  Verdict,
} from "./types.ts";

/** The fields a message list shows. */
export interface MessageSummary {
  id: string;
  threadId: string;
  folder: SystemFolder;
  from?: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  snippet: string;
  date: string;
  receivedAt: string;
  size: number;
  read: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  /** Sent copies only. */
  deliveryStatus?: DeliveryStatus;
}

export interface MessageDetail extends MessageSummary {
  replyTo?: EmailAddress[];
  attachments: AttachmentMeta[];
  messageIdHeader?: string;
  inReplyTo?: string;
  references?: string[];
  auth?: { spf?: Verdict; dkim?: Verdict; dmarc?: Verdict; spam?: Verdict; virus?: Verdict };
  delivery?: OutboundDelivery;
}

/** Body as stored at ingest; html is already sanitized. */
export interface MessageBody {
  text?: string;
  html?: string;
}

export interface MailboxAccess {
  mailboxId: string;
  address: string;
  displayName?: string;
  role: "owner" | "delegate";
  usedBytes: number;
  /** Absent when the mailbox has no quota. */
  quotaBytes?: number;
}

export interface MeResponse {
  email: string;
  name: string | null;
  mailboxes: MailboxAccess[];
}

export interface FolderCount {
  name: SystemFolder;
  total: number;
  unread: number;
}

export interface FoldersResponse {
  folders: FolderCount[];
}

export interface Page<T> {
  items: T[];
  /** Pass back as ?cursor= for the next page; absent on the last page. */
  cursor?: string;
}

export interface MessageResponse {
  message: MessageDetail;
  body: MessageBody;
}

export interface ThreadResponse {
  threadId: string;
  messages: MessageSummary[];
}

export interface MessageChanges {
  read?: boolean;
  flagged?: boolean;
  folder?: SystemFolder;
}

export type BatchAction = "read" | "unread" | "flag" | "unflag" | "move" | "delete";

export interface BatchRequest {
  ids: string[];
  action: BatchAction;
  folder?: SystemFolder;
}

export interface BatchResponse {
  results: { id: string; ok: boolean; error?: string }[];
}

/** Returned by an attachment download with ?as=url. */
export interface DownloadUrl {
  url: string;
  expiresIn: number;
}

/** POST /uploads: ask for somewhere to put one attachment before sending. */
export interface UploadRequest {
  filename: string;
  contentType: string;
  size: number;
}

/** A presigned S3 POST: send `fields` plus the file as multipart/form-data to `url`. */
export interface UploadResponse {
  uploadId: string;
  url: string;
  fields: Record<string, string>;
  maxBytes: number;
}

export interface OutgoingAttachment {
  /** From POST /uploads. */
  uploadId: string;
  filename: string;
  contentType: string;
}

/** POST /mailboxes/:mbx/send */
export interface SendRequest {
  /** Defaults to the mailbox's primary address; may be one of its aliases. */
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  attachments?: OutgoingAttachment[];
  /** Message (in this mailbox) being replied to: sets In-Reply-To and References. */
  inReplyTo?: string;
  /** Message (in this mailbox) being forwarded, with the attachment parts to include. */
  forward?: { id: string; partIds: string[] };
}

export interface SendResponse {
  /** The Sent copy, once ingest files it (usually within a second or two). */
  sentId: string;
  internal: number;
  external: number;
}

/** GET /mailboxes/:mbx/search?q= */
export interface SearchResponse extends Page<MessageSummary> {
  /** A word matched so many messages that older matches may be missing. */
  truncated?: boolean;
}

/** A phone that signed in with an app password. */
export interface DeviceSummary {
  deviceId: string;
  deviceType: string;
  model?: string;
  os?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface AppPasswordSummary {
  id: string;
  label: string;
  mailboxId: string;
  /** The mailbox's primary address; absent when the user no longer has access to it. */
  address?: string;
  createdAt: string;
  lastUsedAt?: string;
  devices: DeviceSummary[];
}

/** GET /app-passwords */
export interface AppPasswordsResponse {
  /** The host name to type into a phone's Exchange account settings, or null when ActiveSync is off. */
  server: string | null;
  passwords: AppPasswordSummary[];
}

/** POST /app-passwords */
export interface CreateAppPasswordRequest {
  mailboxId: string;
  label: string;
}

/** The only time the password itself is returned. */
export interface CreateAppPasswordResponse {
  password: string;
  appPassword: AppPasswordSummary;
}
