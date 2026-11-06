// Pure transformations from a parsed MIME message to what sesame stores.
import type { AttachmentMeta, EmailAddress } from "@sesame/core";
import type { Address, Attachment, Email } from "postal-mime";
import sanitizeHtml from "sanitize-html";

const MAX_ADDRESSES = 100;
const MAX_SUBJECT = 998; // RFC 5322 line limit
const MAX_REFERENCES = 20;
const SNIPPET_LENGTH = 200;

/** Flattens groups, drops entries without an address and caps the list so items stay well under 400 KB. */
export function toAddresses(list: Address[] | Address | undefined): EmailAddress[] {
  if (!list) return [];
  const out: EmailAddress[] = [];
  for (const a of Array.isArray(list) ? list : [list]) {
    for (const m of a.group ?? [a]) {
      if (!m.address) continue;
      out.push(m.name ? { name: m.name, address: m.address } : { address: m.address });
    }
  }
  return out.slice(0, MAX_ADDRESSES);
}

/** Message-IDs from References / In-Reply-To, oldest first, deduplicated. */
export function parseMessageIds(...headers: (string | undefined)[]): string[] {
  const ids = headers.flatMap((h) => h?.match(/<[^<>\s]+>/g) ?? []);
  return [...new Set(ids)].slice(-MAX_REFERENCES);
}

export function normalizeSubject(subject: string | undefined): string {
  return (subject ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT);
}

/** The Date header as ISO 8601, falling back to the receive time. */
export function messageDate(date: string | undefined, receivedAt: string): string {
  const t = date ? Date.parse(date) : Number.NaN;
  return Number.isNaN(t) ? receivedAt : new Date(t).toISOString();
}

export function makeSnippet(text: string | undefined, html: string | undefined): string {
  const source = text ?? (html ? sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }) : "");
  return source.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LENGTH);
}

/**
 * Sanitizes HTML bodies once, at ingest. This is defense in depth: the SPA must still
 * render bodies in a sandboxed iframe (no allow-scripts) with a CSP that blocks
 * remote loads by default. <style> is allowed because most HTML mail depends on it,
 * and it is inert inside that iframe.
 */
export function sanitizeBody(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "img",
      "style",
      "font",
      "center",
      "span",
      "div",
      "u",
      "s",
      "strike",
    ],
    allowVulnerableTags: true,
    allowedAttributes: {
      "*": ["style", "class", "id", "align", "valign", "dir", "lang", "title", "width", "height", "bgcolor"],
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "border"],
      font: ["color", "face", "size"],
      table: ["border", "cellpadding", "cellspacing"],
      td: ["colspan", "rowspan", "nowrap"],
      th: ["colspan", "rowspan", "nowrap"],
      ol: ["start", "type"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "cid", "data"] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" },
      }),
    },
  });
}

export interface StoredAttachment {
  meta: AttachmentMeta;
  content: Uint8Array;
}

export function extractAttachments(attachments: Attachment[]): StoredAttachment[] {
  return attachments.map((a, i) => {
    const content =
      typeof a.content === "string"
        ? new TextEncoder().encode(a.content)
        : a.content instanceof Uint8Array
          ? a.content
          : new Uint8Array(a.content);
    const inline = a.disposition === "inline" || (a.related === true && a.disposition !== "attachment");
    const meta: AttachmentMeta = {
      partId: String(i),
      filename: safeFilename(a.filename, i, a.mimeType),
      contentType: a.mimeType || "application/octet-stream",
      size: content.byteLength,
      inline,
    };
    const cid = a.contentId?.replace(/^<|>$/g, "");
    if (cid) meta.contentId = cid;
    return { meta, content };
  });
}

function safeFilename(name: string | null, index: number, mimeType: string): string {
  const cleaned = (name ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .trim()
    .slice(0, 255);
  if (cleaned) return cleaned;
  const ext = mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "bin";
  return `attachment-${index + 1}.${ext || "bin"}`;
}

export interface Body {
  text?: string;
  html?: string;
}

export function buildBody(email: Email): Body {
  const body: Body = {};
  if (email.text) body.text = email.text;
  if (email.html) body.html = sanitizeBody(email.html);
  return body;
}
