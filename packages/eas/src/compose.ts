// Turns the MIME a phone sends into the message sesame queues.
// - SendMail, and SmartReply or SmartForward with ReplaceMime: the phone's message is complete.
//   Only headers change (Bcc out, sesame's Message-ID, Date when missing, threading for replies).
// - SmartReply or SmartForward without ReplaceMime: the phone sent only what the user typed, and
//   the server adds the original: quoted for a reply, with its attachments for a forward. That
//   needs a new MIME tree, built from the phone's parts plus the original's.
import type { MessageItem } from "@sesame/core";
import MailComposer from "nodemailer/lib/mail-composer";
import PostalMime from "postal-mime";
import type { Deps } from "./deps.ts";
import { formatAddress, htmlToText } from "./items.ts";
import { ObjectMissingError, readBodyJson, readObject } from "./mailbox.ts";
import { headerAddress, type MimeMessage, type ParsedAddress } from "./mime.ts";

export type ComposeKind = "SendMail" | "SmartReply" | "SmartForward";

/** Values for the outgoing message, decided by queueOutgoing and the caller. */
export interface Envelope {
  messageId: string;
  date: Date;
  /** The address to send from: the phone's own From, or the mailbox's primary address. */
  from: ParsedAddress;
  /** Whether `from` replaces the phone's From header. */
  rewriteFrom: boolean;
}

/** A message that can't be built; `status` is the ComposeMail status for the phone. */
export class ComposeError extends Error {
  constructor(readonly status: number) {
    super(`compose failed with status ${status}`);
  }
}

const ATTACHMENT_MISSING = 120;

function threading(original: MessageItem): { inReplyTo?: string; references?: string[] } {
  if (!original.messageIdHeader) return {};
  return {
    inReplyTo: original.messageIdHeader,
    references: [...(original.references ?? []), original.messageIdHeader].slice(-20),
  };
}

/** The phone's message with header edits only; the body bytes are untouched. */
export function editHeaders(
  msg: MimeMessage,
  envelope: Envelope,
  kind: ComposeKind,
  original: MessageItem | undefined,
): Buffer {
  // Bcc recipients only exist in the envelope, so they never see each other.
  msg.remove("Bcc");
  msg.set("Message-ID", envelope.messageId);
  if (!msg.get("Date")) msg.set("Date", envelope.date.toUTCString());
  if (envelope.rewriteFrom) msg.set("From", headerAddress(envelope.from.name, envelope.from.address));
  if (kind === "SmartReply" && original) {
    const t = threading(original);
    if (t.inReplyTo && !msg.get("In-Reply-To")) msg.set("In-Reply-To", t.inReplyTo);
    if (t.references && !msg.get("References")) msg.set("References", t.references.join(" "));
  }
  return msg.toBuffer();
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const textToHtml = (s: string) => `<div style="white-space:pre-wrap">${escapeHtml(s)}</div>`;

/** Puts `extra` before the closing body tag, or at the end when there's none. */
function appendHtml(html: string, extra: string): string {
  const i = html.search(/<\/body>/i);
  return i < 0 ? html + extra : html.slice(0, i) + extra + html.slice(i);
}

/** The original's text and HTML to add under the phone's: quoted for a reply, a header block for a forward. */
async function quoteOriginal(deps: Deps, original: MessageItem, kind: ComposeKind) {
  const body = await readBodyJson(deps, original);
  const text = body.text ?? (body.html ? htmlToText(body.html) : "");
  const html = body.html ?? textToHtml(text);
  const when = new Date(original.date).toUTCString();
  const from = original.from ? formatAddress(original.from) : "";
  if (kind === "SmartReply") {
    const quoted = text
      .split(/\r?\n/)
      .map((l) => (l ? `> ${l}` : ">"))
      .join("\n");
    return {
      text: `\n\nOn ${when}, ${from} wrote:\n\n${quoted}\n`,
      html:
        `<br><br><div>On ${escapeHtml(when)}, ${escapeHtml(from)} wrote:</div>` +
        `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${html}</blockquote>`,
    };
  }
  const lines: [string, string][] = [
    ["From", from],
    ["Date", when],
    ["Subject", original.subject],
    ["To", original.to.map(formatAddress).join(", ")],
  ];
  if (original.cc.length) lines.push(["Cc", original.cc.map(formatAddress).join(", ")]);
  return {
    text: `\n\n---------- Forwarded message ----------\n${lines.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${text}\n`,
    html:
      `<br><br><div>---------- Forwarded message ----------<br>` +
      lines.map(([k, v]) => `${k}: ${escapeHtml(v)}`).join("<br>") +
      `</div><br>${html}`,
  };
}

interface Part {
  filename: string;
  contentType: string;
  content: Buffer;
  cid?: string;
  inline?: boolean;
}

/** The original's attachments, so a forward carries them even when the phone never downloaded them. */
async function originalAttachments(deps: Deps, original: MessageItem): Promise<Part[]> {
  const parts: Part[] = [];
  for (const a of original.attachments) {
    try {
      const { bytes } = await readObject(deps, `${original.objectPrefix}att/${a.partId}`);
      const part: Part = { filename: a.filename, contentType: a.contentType, content: bytes };
      if (a.contentId) part.cid = a.contentId.replace(/^<|>$/g, "");
      if (a.inline) part.inline = true;
      parts.push(part);
    } catch (err) {
      if (err instanceof ObjectMissingError) throw new ComposeError(ATTACHMENT_MISSING);
      throw err;
    }
  }
  return parts;
}

/**
 * A new message from the phone's parts and the original's. Recipients come from the phone's
 * headers (Bcc left out, as always); the body is what the user typed, then the original.
 */
export async function recompose(
  deps: Deps,
  raw: Buffer,
  envelope: Envelope,
  kind: ComposeKind,
  original: MessageItem,
): Promise<Buffer> {
  const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  const quote = await quoteOriginal(deps, original, kind);
  const typed = email.text ?? (email.html ? htmlToText(email.html) : "");
  const parts: Part[] = email.attachments.map((a) => {
    const part: Part = {
      filename: a.filename ?? "attachment",
      contentType: a.mimeType,
      content: Buffer.from(a.content as ArrayBuffer),
    };
    if (a.contentId) part.cid = a.contentId.replace(/^<|>$/g, "");
    if (a.disposition === "inline") part.inline = true;
    return part;
  });
  if (kind === "SmartForward") parts.push(...(await originalAttachments(deps, original)));

  const list = (xs: { name: string; address?: string }[] | undefined) =>
    (xs ?? []).flatMap((x) => (x.address ? [{ name: x.name, address: x.address }] : []));
  const reply = kind === "SmartReply" ? threading(original) : {};
  const composer = new MailComposer({
    from: envelope.from.name ? envelope.from : envelope.from.address,
    to: list(email.to),
    cc: list(email.cc),
    subject: email.subject ?? "",
    messageId: envelope.messageId,
    date: envelope.date,
    text: typed + quote.text,
    // HTML only when the phone wrote some; a plain text reply stays plain.
    ...(email.html ? { html: appendHtml(email.html, quote.html) } : {}),
    ...(email.inReplyTo || reply.inReplyTo ? { inReplyTo: email.inReplyTo ?? reply.inReplyTo } : {}),
    ...(email.references || reply.references ? { references: email.references ?? reply.references } : {}),
    attachments: parts.map((p) => ({
      filename: p.filename,
      contentType: p.contentType,
      content: p.content,
      ...(p.cid ? { cid: p.cid } : {}),
      ...(p.inline ? { contentDisposition: "inline" as const } : {}),
    })),
  });
  return new Promise((resolve, reject) =>
    composer.compile().build((err: Error | null, message: Buffer) => (err ? reject(err) : resolve(message))),
  );
}
