// Compose outgoing mail from the web app's form. The API builds the MIME; queueOutgoing in core
// checks and routes it, the same way it routes mail phones send over ActiveSync.
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  domainOf,
  isValidAddress,
  MAX_RECIPIENTS,
  type MessageItem,
  newUlid,
  normalizeAddress,
  type OutgoingAttachment,
  OutgoingError,
  type OutgoingErrorCode,
  queueOutgoing,
  type SendRequest,
  type SendResponse,
  type UploadRequest,
  type UploadResponse,
} from "@sesame/core";
import { HTTPException } from "hono/http-exception";
import MailComposer from "nodemailer/lib/mail-composer";
import type { Deps, SessionUser } from "./deps.ts";
import { requireMessage } from "./mail.ts";

/** SES v2 accepts up to 40 MB per message, after base64 (about 4/3 larger). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const MAX_TEXT_BYTES = 1024 * 1024;
const UPLOAD_SECONDS = 15 * 60;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const bad = (message: string) => new HTTPException(400, { message });

// --- Uploads ----------------------------------------------------------------

export function stagingKey(user: SessionUser, uploadId: string): string {
  return `staging/${user.sub}/${uploadId}`;
}

/** A presigned POST for one attachment; S3 enforces the size and content type. */
export async function createUpload(deps: Deps, user: SessionUser, body: unknown): Promise<UploadResponse> {
  const req = body as Partial<UploadRequest>;
  if (typeof req.filename !== "string" || !req.filename.trim() || req.filename.length > 255) {
    throw bad("filename is required (at most 255 characters)");
  }
  const contentType =
    typeof req.contentType === "string" && req.contentType ? req.contentType : "application/octet-stream";
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) throw bad("invalid contentType");
  if (typeof req.size !== "number" || req.size < 1 || req.size > MAX_ATTACHMENT_BYTES) {
    throw bad(`size must be 1-${MAX_ATTACHMENT_BYTES} bytes`);
  }
  const uploadId = newUlid(deps.now());
  const { url, fields } = await deps.presignPost({
    Bucket: deps.config.mailBucket,
    Key: stagingKey(user, uploadId),
    Conditions: [
      ["content-length-range", 1, MAX_ATTACHMENT_BYTES],
      ["eq", "$Content-Type", contentType],
    ],
    Fields: { "Content-Type": contentType },
    Expires: UPLOAD_SECONDS,
  });
  return { uploadId, url, fields, maxBytes: MAX_ATTACHMENT_BYTES };
}

// --- Validation ---------------------------------------------------------------

export interface ValidSend {
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  attachments: OutgoingAttachment[];
  inReplyTo?: string;
  forward?: { id: string; partIds: string[] };
}

function addressList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw bad(`${field} must be a list of addresses`);
  return value.map((a) => {
    if (typeof a !== "string" || !isValidAddress(a)) throw bad(`invalid address in ${field}: ${String(a)}`);
    return normalizeAddress(a);
  });
}

export function validateSend(body: unknown): ValidSend {
  if (typeof body !== "object" || body === null) throw bad("expected a JSON object");
  const req = body as Partial<SendRequest>;
  const to = addressList(req.to, "to");
  const cc = addressList(req.cc, "cc");
  const bcc = addressList(req.bcc, "bcc");
  const all = new Set([...to, ...cc, ...bcc]);
  if (all.size === 0) throw bad("add at least one recipient");
  if (all.size > MAX_RECIPIENTS) throw bad(`at most ${MAX_RECIPIENTS} recipients per message`);

  if (typeof req.subject !== "string" || req.subject.length > 998)
    throw bad("subject must be a string under 998 characters");
  if (typeof req.text !== "string" || Buffer.byteLength(req.text) > MAX_TEXT_BYTES)
    throw bad("text must be a string under 1 MB");

  const attachments = req.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) {
    throw bad(`at most ${MAX_ATTACHMENTS} attachments`);
  }
  for (const a of attachments) {
    if (typeof a?.uploadId !== "string" || !ULID.test(a.uploadId)) throw bad("invalid uploadId");
    if (typeof a.filename !== "string" || !a.filename.trim() || a.filename.length > 255)
      throw bad("invalid filename");
    if (typeof a.contentType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(a.contentType))
      throw bad("invalid contentType");
  }

  const out: ValidSend = { to, cc, bcc, subject: req.subject, text: req.text, attachments };
  if (req.from !== undefined) {
    if (typeof req.from !== "string" || !isValidAddress(req.from)) throw bad("invalid from address");
    out.from = normalizeAddress(req.from);
  }
  if (req.inReplyTo !== undefined) {
    if (typeof req.inReplyTo !== "string" || !ULID.test(req.inReplyTo)) throw bad("invalid inReplyTo");
    out.inReplyTo = req.inReplyTo;
  }
  if (req.forward !== undefined) {
    const f = req.forward;
    if (typeof f?.id !== "string" || !ULID.test(f.id) || !Array.isArray(f.partIds))
      throw bad("invalid forward");
    if (!f.partIds.every((p) => typeof p === "string" && /^\d{1,4}$/.test(p)))
      throw bad("invalid forward partIds");
    out.forward = { id: f.id, partIds: f.partIds };
  }
  return out;
}

// --- Sending ------------------------------------------------------------------

async function readObject(deps: Deps, key: string): Promise<Buffer | undefined> {
  try {
    const res = await deps.s3.send(new GetObjectCommand({ Bucket: deps.config.mailBucket, Key: key }));
    return Buffer.from((await res.Body?.transformToByteArray()) ?? []);
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") return undefined;
    throw err;
  }
}

interface Part {
  filename: string;
  contentType: string;
  content: Buffer;
}

async function collectAttachments(
  deps: Deps,
  user: SessionUser,
  req: ValidSend,
  forwarded?: MessageItem,
): Promise<Part[]> {
  const parts: Part[] = [];
  for (const a of req.attachments) {
    const content = await readObject(deps, stagingKey(user, a.uploadId));
    if (!content) throw bad(`upload ${a.uploadId} not found; it may have expired`);
    parts.push({ filename: a.filename, contentType: a.contentType, content });
  }
  if (forwarded && req.forward) {
    for (const partId of req.forward.partIds) {
      const meta = forwarded.attachments.find((p) => p.partId === partId);
      if (!meta) throw bad(`the forwarded message has no part ${partId}`);
      const content = await readObject(deps, `${forwarded.objectPrefix}att/${partId}`);
      if (!content) throw bad(`attachment ${meta.filename} is missing`);
      parts.push({ filename: meta.filename, contentType: meta.contentType, content });
    }
  }
  const total = parts.reduce((n, p) => n + p.content.byteLength, 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new HTTPException(413, {
      message: `attachments total more than ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MB`,
    });
  }
  return parts;
}

export function buildMime(opts: {
  from: { name?: string; address: string };
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  messageId: string;
  date: Date;
  inReplyTo?: string;
  references?: string[];
  attachments: Part[];
}): Promise<Buffer> {
  // Bcc is deliberately absent: Bcc recipients only exist in the envelope.
  const composer = new MailComposer({
    from: opts.from.name ? { name: opts.from.name, address: opts.from.address } : opts.from.address,
    to: opts.to,
    cc: opts.cc,
    subject: opts.subject,
    text: opts.text,
    messageId: opts.messageId,
    date: opts.date,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
    attachments: opts.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content,
    })),
    headers: { "X-Mailer": "sesame" },
  });
  return new Promise((resolve, reject) =>
    composer.compile().build((err: Error | null, message: Buffer) => (err ? reject(err) : resolve(message))),
  );
}

const HTTP_STATUS: Record<OutgoingErrorCode, 400 | 404 | 422 | 429> = {
  "no-recipients": 400,
  "too-many-recipients": 400,
  "bad-from": 400,
  "mailbox-not-found": 404,
  "unknown-recipient": 422,
  "mailbox-full": 422,
  "recipient-full": 422,
  suppressed: 422,
  "rate-limited": 429,
};

export async function sendMessage(
  deps: Deps,
  user: SessionUser,
  mailboxId: string,
  body: unknown,
): Promise<SendResponse> {
  const req = validateSend(body);
  const original = req.inReplyTo ? await requireMessage(deps, mailboxId, req.inReplyTo) : undefined;
  const forwarded = req.forward ? await requireMessage(deps, mailboxId, req.forward.id) : undefined;
  try {
    const result = await queueOutgoing(deps, {
      mailboxId,
      userId: user.email,
      ...(req.from ? { from: req.from } : {}),
      recipients: [...req.to, ...req.cc, ...req.bcc],
      compose: async ({ id, date, from, mailbox }) => {
        const opts: Parameters<typeof buildMime>[0] = {
          from: mailbox.displayName ? { name: mailbox.displayName, address: from } : { address: from },
          to: req.to,
          cc: req.cc,
          subject: req.subject,
          text: req.text,
          messageId: `<${id.toLowerCase()}@${domainOf(from)}>`,
          date,
          attachments: await collectAttachments(deps, user, req, forwarded),
        };
        if (original?.messageIdHeader) {
          opts.inReplyTo = original.messageIdHeader;
          opts.references = [...(original.references ?? []), original.messageIdHeader].slice(-20);
        }
        return buildMime(opts);
      },
    });
    return { sentId: result.sentUlid, internal: result.internal, external: result.external };
  } catch (err) {
    if (err instanceof OutgoingError)
      throw new HTTPException(HTTP_STATUS[err.code], { message: err.message });
    throw err;
  }
}
