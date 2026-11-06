// Drafting helpers for compose, reply and forward. Pure, so they're unit tested.
import type { EmailAddress, MessageDetail } from "@sesame/core/dto";
import { formatAddress, formatAddresses, formatFullDate } from "./format.ts";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export interface Draft {
  mode: ComposeMode;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  /** Message being replied to. */
  inReplyTo?: string;
  /** Message being forwarded and its attachments on offer. */
  forward?: { id: string; parts: { partId: string; filename: string; size: number }[] };
}

export const emptyDraft = (): Draft => ({ mode: "new", to: "", cc: "", bcc: "", subject: "", text: "" });

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/**
 * Parses what someone typed into a recipient field: commas, semicolons or newlines between
 * entries, each either a bare address or "Name <address>". Returns addresses plus the entries
 * that aren't valid, so the form can point at them.
 */
export function parseAddressList(input: string): { addresses: string[]; invalid: string[] } {
  const addresses: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[,;\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const angle = entry.match(/<([^<>]+)>\s*$/);
    const address = (angle?.[1] ?? entry).trim().replace(/^mailto:/i, "");
    if (ADDRESS.test(address)) addresses.push(address.toLowerCase());
    else invalid.push(entry);
  }
  return { addresses: [...new Set(addresses)], invalid };
}

export function prefixSubject(prefix: "Re" | "Fwd", subject: string): string {
  const pattern = prefix === "Re" ? /^\s*re\s*:/i : /^\s*(fwd?|fw)\s*:/i;
  return pattern.test(subject) ? subject : `${prefix}: ${subject}`.trimEnd();
}

function quote(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .trimEnd()
    .split("\n")
    .map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`))
    .join("\n");
}

const lower = (a: EmailAddress) => a.address.toLowerCase();

/** Builds a reply, reply-all or forward draft. `mine` are the user's own addresses, left out of reply-all. */
export function draftFrom(
  mode: Exclude<ComposeMode, "new">,
  message: MessageDetail,
  bodyText: string,
  mine: string[],
): Draft {
  const own = new Set(mine.map((a) => a.toLowerCase()));
  const sender = message.from ? [message.from] : [];

  if (mode === "forward") {
    const header = [
      "---------- Forwarded message ---------",
      `From: ${message.from ? formatAddress(message.from) : ""}`,
      `Date: ${formatFullDate(message.date)}`,
      `Subject: ${message.subject}`,
      `To: ${formatAddresses(message.to)}`,
      ...(message.cc.length ? [`Cc: ${formatAddresses(message.cc)}`] : []),
    ].join("\n");
    return {
      mode,
      to: "",
      cc: "",
      bcc: "",
      subject: prefixSubject("Fwd", message.subject),
      text: `\n\n${header}\n\n${bodyText.trimEnd()}\n`,
      forward: {
        id: message.id,
        parts: message.attachments
          .filter((a) => !a.inline)
          .map((a) => ({ partId: a.partId, filename: a.filename, size: a.size })),
      },
    };
  }

  // Our own Sent message: replying goes back to its recipients, not to ourselves.
  const fromMe = message.from ? own.has(lower(message.from)) : false;
  const primary = fromMe ? message.to : message.replyTo?.length ? message.replyTo : sender;
  const to = primary.filter((a) => !own.has(lower(a)) || fromMe);
  const seen = new Set(to.map(lower));
  const cc =
    mode === "replyAll"
      ? [...message.to, ...message.cc].filter((a) => {
          const key = lower(a);
          if (own.has(key) || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
      : [];
  const who = message.from ? formatAddress(message.from) : "someone";
  return {
    mode,
    to: to.map(formatAddress).join(", "),
    cc: cc.map(formatAddress).join(", "),
    bcc: "",
    subject: prefixSubject("Re", message.subject),
    text: `\n\nOn ${formatFullDate(message.date)}, ${who} wrote:\n${quote(bodyText)}\n`,
    inReplyTo: message.id,
  };
}

/** Readable text from an HTML body, for quoting. Needs a DOM, so it runs in the browser only. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("style, script, head")) el.remove();
  for (const br of doc.querySelectorAll("br")) br.replaceWith("\n");
  for (const block of doc.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote")) {
    block.append("\n");
  }
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
