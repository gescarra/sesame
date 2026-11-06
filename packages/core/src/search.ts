// Full-text search on DynamoDB: an inverted index of normalized tokens.
//
// Each (token, message) pair is one item: pk MBX#{mbx}#S#{first two chars}, sk {token}#{ulid}.
// A prefix query on one shard finds every message with a token starting with the search term.
// The `f` attribute is the set of fields the token appeared in, so `from:bob` can filter on it.
import { BatchWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SystemFolder } from "./folders.ts";
import { isSystemFolder } from "./folders.ts";
import { mailKeys } from "./keys.ts";

/** s=subject, f=from, t=to/cc, b=body, a=attachment filename */
export type SearchField = "s" | "f" | "t" | "b" | "a";

export const MAX_TOKENS = 200;
export const MAX_BODY_CHARS = 8 * 1024;
const MIN_LENGTH = 2;
const MAX_LENGTH = 40;

// Common English words that would match most messages and cost a write each.
const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have he her his i if in into is it its me my no not of on or our " +
    "she so that the their them there these they this to was we were what when which who will with you your " +
    "re fw fwd am pm do did can just been would could should all any about than then also only very"
  ).split(" "),
);

/** Lowercases and strips accents, so "Résumé" and "resume" match. */
export function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function keep(token: string): boolean {
  return token.length >= MIN_LENGTH && token.length <= MAX_LENGTH && !STOPWORDS.has(token);
}

/** Words of free text, folded and filtered, in order of appearance. */
export function words(text: string): string[] {
  return (fold(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter(keep);
}

/** An address is findable whole, by its local part, its domain and each label of the domain. */
export function addressTokens(address: string): string[] {
  const a = fold(address.trim());
  const at = a.lastIndexOf("@");
  if (at < 1) return words(a);
  const local = a.slice(0, at);
  const domain = a.slice(at + 1);
  const parts = [a, local, domain, ...domain.split("."), ...words(local)];
  return [...new Set(parts)].filter((t) => t.length >= MIN_LENGTH && t.length <= 80 && !t.includes("#"));
}

/** Plain text from an HTML body, good enough for indexing. */
export function htmlToSearchText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

export interface IndexInput {
  subject: string;
  from?: { name?: string; address: string };
  to: { name?: string; address: string }[];
  cc: { name?: string; address: string }[];
  attachmentNames: string[];
  bodyText?: string;
}

export type SearchIndex = Map<string, Set<SearchField>>;

/**
 * Tokens for one message with the fields they came from. Capped at MAX_TOKENS, filled in
 * priority order: subject, sender, recipients, attachment names, then body.
 */
export function buildIndex(input: IndexInput): SearchIndex {
  const index: SearchIndex = new Map();
  const add = (field: SearchField, tokens: string[]) => {
    for (const t of tokens) {
      const fields = index.get(t);
      if (fields) fields.add(field);
      else if (index.size < MAX_TOKENS) index.set(t, new Set([field]));
    }
  };
  const person = (p: { name?: string; address: string }) => [
    ...addressTokens(p.address),
    ...words(p.name ?? ""),
  ];

  add("s", words(input.subject));
  if (input.from) add("f", person(input.from));
  for (const p of [...input.to, ...input.cc]) add("t", person(p));
  for (const name of input.attachmentNames) add("a", words(name));
  if (input.bodyText) add("b", words(input.bodyText.slice(0, MAX_BODY_CHARS)));
  return index;
}

export interface SearchTokenItem {
  pk: string;
  sk: string;
  type: "search";
  ulid: string;
  f: Set<SearchField>;
}

async function batchWrite(doc: DynamoDBDocumentClient, table: string, requests: Record<string, unknown>[]) {
  for (let i = 0; i < requests.length; i += 25) {
    let pending = requests.slice(i, i + 25);
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(2000, 50 * 2 ** attempt)));
      if (attempt > 8) throw new Error(`BatchWrite on ${table} left ${pending.length} requests unprocessed`);
      const res = await doc.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
      pending = (res.UnprocessedItems?.[table] as Record<string, unknown>[] | undefined) ?? [];
    }
  }
}

/** Deletes items by key, 25 per request, retrying unprocessed ones. */
export async function deleteKeys(
  doc: DynamoDBDocumentClient,
  table: string,
  keys: Record<string, unknown>[],
) {
  await batchWrite(
    doc,
    table,
    keys.map((Key) => ({ DeleteRequest: { Key } })),
  );
}

/** Writes the index items. Idempotent: rewriting the same tokens overwrites the same keys. */
export async function writeIndex(
  doc: DynamoDBDocumentClient,
  table: string,
  mailboxId: string,
  ulid: string,
  index: SearchIndex,
) {
  const requests = [...index].map(([token, fields]) => {
    const item: SearchTokenItem = {
      ...mailKeys.searchToken(mailboxId, token, ulid),
      type: "search",
      ulid,
      f: fields,
    };
    return { PutRequest: { Item: item } };
  });
  await batchWrite(doc, table, requests);
}

export async function deleteIndex(
  doc: DynamoDBDocumentClient,
  table: string,
  mailboxId: string,
  ulid: string,
  tokens: string[],
) {
  await batchWrite(
    doc,
    table,
    tokens.map((token) => ({ DeleteRequest: { Key: mailKeys.searchToken(mailboxId, token, ulid) } })),
  );
}

// --- Queries ------------------------------------------------------------------

export interface SearchTerm {
  /** Folded prefix to match tokens against. */
  prefix: string;
  /** Only tokens from this field. */
  field?: SearchField;
}

export interface SearchQuery {
  terms: SearchTerm[];
  hasAttachment: boolean;
  /** A folder, or "anywhere" to include junk and trash, which are left out by default. */
  folder?: SystemFolder | "anywhere";
  unread: boolean;
  flagged: boolean;
}

const FIELD_OPERATORS: Record<string, SearchField> = {
  from: "f",
  to: "t",
  cc: "t",
  subject: "s",
  body: "b",
  file: "a",
  filename: "a",
};

/**
 * Parses a search box. Words match by prefix, all must match. Operators: from:, to:, subject:,
 * body:, file:, has:attachment, is:unread, is:flagged, in:<folder>|anywhere. Quotes group words
 * for an operator (subject:"q3 report").
 */
export function parseQuery(input: string): SearchQuery {
  const query: SearchQuery = { terms: [], hasAttachment: false, unread: false, flagged: false };
  for (const m of input.matchAll(/(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+)/g)) {
    const op = (m[1] ?? m[3])?.toLowerCase();
    const value = m[2] ?? m[4] ?? m[5] ?? m[6] ?? "";
    if (op === "has" && /^attachments?$/i.test(value)) {
      query.hasAttachment = true;
    } else if (op === "is" && /^unread$/i.test(value)) {
      query.unread = true;
    } else if (op === "is" && /^(flagged|starred)$/i.test(value)) {
      query.flagged = true;
    } else if (op === "in") {
      const folder = value.toLowerCase();
      if (folder === "anywhere" || folder === "all") query.folder = "anywhere";
      else if (isSystemFolder(folder)) query.folder = folder;
    } else if (op && FIELD_OPERATORS[op]) {
      const field = FIELD_OPERATORS[op];
      const tokens = field === "f" || field === "t" ? fold(value).split(/\s+/).filter(Boolean) : words(value);
      for (const t of tokens) {
        // An address operand is matched whole when it has an @, by words otherwise.
        const prefixes = t.includes("@") ? [t] : words(t);
        for (const prefix of prefixes) if (prefix.length >= MIN_LENGTH) query.terms.push({ prefix, field });
      }
    } else {
      const text = op ? `${op}:${value}` : value;
      const tokens = text.includes("@") ? [fold(text)] : words(text);
      for (const prefix of tokens) query.terms.push({ prefix });
    }
  }
  return query;
}
