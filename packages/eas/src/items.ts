// A stored message as an ActiveSync Email item: the ApplicationData of a Sync Add or Fetch and
// the Properties of an ItemOperations Fetch. Bodies are the original MIME when the phone asks for
// it (iOS does), read from message.eml and cut at the size it asks for.
import type { EmailAddress, MessageItem } from "@sesame/core";
import type { Deps } from "./deps.ts";
import { fileReference, isUlid, ulidToBytes } from "./ids.ts";
import { readBodyJson, readObject } from "./mailbox.ts";
import type { BodyPreference, SyncOptions } from "./state.ts";
import { type Element, el } from "./wbxml/codec.ts";

export const BodyType = { Text: 1, Html: 2, Mime: 4 } as const;

/** The one body format to send, from the phone's preferences in its order of asking. */
export function chooseBody(options: Pick<SyncOptions, "bodyPreferences">): BodyPreference {
  const prefs = options.bodyPreferences;
  return (
    prefs.find((p) => p.type === BodyType.Mime) ??
    prefs.find((p) => p.type === BodyType.Html) ??
    prefs.find((p) => p.type === BodyType.Text) ?? { type: BodyType.Text, truncationSize: 32 * 1024 }
  );
}

export function formatAddress(a: EmailAddress): string {
  return a.name ? `"${a.name.replace(/["\\]/g, "\\$&")}" <${a.address}>` : a.address;
}

const formatList = (list: EmailAddress[]) => list.map(formatAddress).join(", ");

export function threadTopic(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?|aw|wg|sv|tr)\s*(\[\d+\])?\s*:)+\s*/i, "");
}

export function flagElement(flagged: boolean): Element {
  return flagged
    ? el("Email:Flag", [el("Email:FlagStatus", "2"), el("Email:FlagType", "for Follow Up")])
    : el("Email:Flag");
}

/** The fields a Sync Change carries: the two a phone or the web app can change. */
export function changeData(m: Pick<MessageItem, "read" | "flagged">): Element[] {
  return [el("Email:Read", m.read ? "1" : "0"), flagElement(m.flagged)];
}

/** Cuts UTF-8 text to at most `max` bytes without splitting a character. */
function cutUtf8(text: string, max: number): Buffer {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return bytes;
  let end = max;
  // Back up over continuation bytes (10xxxxxx) to a character boundary.
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Body bytes sent, so a Sync can stop adding items before its response grows too large. */
export interface Built {
  data: Element[];
  bodyBytes: number;
}

export async function bodyElement(deps: Deps, m: MessageItem, pref: BodyPreference): Promise<Built> {
  const limit = pref.truncationSize;
  const parts: Element[] = [];
  let bodyBytes = 0;

  if (pref.type === BodyType.Mime) {
    const truncated = limit !== undefined && m.size > limit;
    parts.push(el("AirSyncBase:Type", BodyType.Mime), el("AirSyncBase:EstimatedDataSize", m.size));
    if (truncated) parts.push(el("AirSyncBase:Truncated", "1"));
    if (!(truncated && (pref.allOrNone || limit === 0))) {
      const { bytes } = await readObject(
        deps,
        `${m.objectPrefix}message.eml`,
        truncated ? { start: 0, end: (limit as number) - 1 } : undefined,
      );
      parts.push({ tag: "AirSyncBase:Data", inline: bytes });
      bodyBytes = bytes.length;
    }
  } else {
    const body = await readBodyJson(deps, m);
    const type = pref.type === BodyType.Html ? BodyType.Html : BodyType.Text;
    const content =
      type === BodyType.Html
        ? (body.html ?? (body.text ? `<pre>${escapeHtml(body.text)}</pre>` : ""))
        : (body.text ?? (body.html ? htmlToText(body.html) : ""));
    const size = Buffer.byteLength(content, "utf8");
    const truncated = limit !== undefined && size > limit;
    parts.push(el("AirSyncBase:Type", type), el("AirSyncBase:EstimatedDataSize", size));
    if (truncated) parts.push(el("AirSyncBase:Truncated", "1"));
    if (!(truncated && pref.allOrNone)) {
      const data = truncated ? cutUtf8(content, limit as number) : Buffer.from(content, "utf8");
      if (data.length) parts.push(el("AirSyncBase:Data", data.toString("utf8")));
      bodyBytes = data.length;
    }
  }
  if (pref.preview && m.snippet) parts.push(el("AirSyncBase:Preview", m.snippet.slice(0, pref.preview)));
  return { data: [el("AirSyncBase:Body", parts)], bodyBytes };
}

/** Attachment list for HTML and text bodies; a MIME body carries its own attachments. */
function attachmentsElement(m: MessageItem): Element | undefined {
  if (!m.attachments.length) return undefined;
  return el(
    "AirSyncBase:Attachments",
    m.attachments.map((a) =>
      el("AirSyncBase:Attachment", [
        el("AirSyncBase:DisplayName", a.filename || "attachment"),
        el("AirSyncBase:FileReference", fileReference(m.messageUlid, a.partId)),
        el("AirSyncBase:Method", "1"),
        el("AirSyncBase:EstimatedDataSize", a.size),
        a.contentId ? el("AirSyncBase:ContentId", a.contentId) : undefined,
        a.inline ? el("AirSyncBase:IsInline", "1") : undefined,
      ]),
    ),
  );
}

/** Every field of the item, with the body in the preferred format. */
export async function emailData(deps: Deps, m: MessageItem, pref: BodyPreference): Promise<Built> {
  const body = await bodyElement(deps, m, pref);
  const data: Element[] = [
    m.to.length ? el("Email:To", formatList(m.to)) : undefined,
    m.cc.length ? el("Email:Cc", formatList(m.cc)) : undefined,
    m.from ? el("Email:From", formatAddress(m.from)) : undefined,
    el("Email:Subject", m.subject),
    m.replyTo?.length ? el("Email:ReplyTo", formatList(m.replyTo)) : undefined,
    el("Email:DateReceived", new Date(m.receivedAt).toISOString()),
    m.to.length ? el("Email:DisplayTo", m.to.map((a) => a.name || a.address).join("; ")) : undefined,
    el("Email:ThreadTopic", threadTopic(m.subject)),
    el("Email:Importance", "1"),
    el("Email:Read", m.read ? "1" : "0"),
    pref.type === BodyType.Mime ? undefined : attachmentsElement(m),
    ...body.data,
    el("Email:MessageClass", "IPM.Note"),
    el("Email:InternetCPID", "65001"),
    flagElement(m.flagged),
    el("Email:ContentClass", "urn:content-classes:message"),
    isUlid(m.threadId) ? el("Email2:ConversationId", ulidToBytes(m.threadId)) : undefined,
  ].filter((e): e is Element => Boolean(e));
  return { data, bodyBytes: body.bodyBytes };
}
