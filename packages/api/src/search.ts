// Search over the token index. Each word is one prefix query on its shard. The results are
// intersected, sorted newest first, and loaded and filtered page by page.
import { QueryCommand, type QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import {
  batchGet,
  type MessageItem,
  mailKeys,
  parseQuery,
  type SearchQuery,
  type SearchResponse,
  type SearchTerm,
  searchShard,
} from "@sesame/core";
import { HTTPException } from "hono/http-exception";
import type { Deps } from "./deps.ts";
import { toSummary } from "./mail.ts";

/** Index entries read per word. A word matching more than this is too common to rank exactly. */
export const MAX_MATCHES_PER_TERM = 2000;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Message IDs with a token starting with the term, and whether the cap cut the list short. */
async function matchTerm(deps: Deps, mailboxId: string, term: SearchTerm) {
  const ids = new Set<string>();
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  let read = 0;
  do {
    const input: QueryCommandInput = {
      TableName: deps.config.mailTable,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": searchShard(mailboxId, term.prefix), ":prefix": term.prefix },
      ProjectionExpression: "ulid",
      ExclusiveStartKey,
      Limit: Math.min(1000, MAX_MATCHES_PER_TERM - read),
    };
    if (term.field) {
      input.FilterExpression = "contains(f, :field)";
      input.ExpressionAttributeValues = { ...input.ExpressionAttributeValues, ":field": term.field };
    }
    const res = await deps.doc.send(new QueryCommand(input));
    read += res.ScannedCount ?? 0;
    for (const item of res.Items ?? []) ids.add(String(item.ulid));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey && read < MAX_MATCHES_PER_TERM);
  return { ids, truncated: Boolean(ExclusiveStartKey) };
}

function matchesFilters(m: MessageItem, q: SearchQuery): boolean {
  if (
    q.folder === undefined
      ? m.folder === "junk" || m.folder === "trash"
      : q.folder !== "anywhere" && m.folder !== q.folder
  ) {
    return false;
  }
  if (q.hasAttachment && !m.hasAttachments) return false;
  if (q.unread && m.read) return false;
  if (q.flagged && !m.flagged) return false;
  return true;
}

export async function search(
  deps: Deps,
  mailboxId: string,
  input: { q: string; limit: number; cursor?: string },
): Promise<SearchResponse> {
  const query = parseQuery(input.q);
  if (query.terms.length === 0) throw new HTTPException(400, { message: "search for at least one word" });
  if (input.cursor !== undefined && !ULID.test(input.cursor))
    throw new HTTPException(400, { message: "invalid cursor" });

  // Duplicate terms ("report report") cost queries without changing the result.
  const terms = [...new Map(query.terms.map((t) => [`${t.field ?? ""}:${t.prefix}`, t])).values()];
  const matches = await Promise.all(terms.map((t) => matchTerm(deps, mailboxId, t)));
  matches.sort((a, b) => a.ids.size - b.ids.size);
  const [smallest, ...rest] = matches;
  const ids = [...(smallest?.ids ?? [])]
    .filter((id) => rest.every((m) => m.ids.has(id)))
    .filter((id) => input.cursor === undefined || id < input.cursor)
    .sort()
    .reverse();

  const items: MessageItem[] = [];
  let examined = 0;
  while (examined < ids.length && items.length < input.limit) {
    const chunk = ids.slice(examined, examined + 100);
    const loaded = (await batchGet(
      deps.doc,
      deps.config.mailTable,
      chunk.map((id) => mailKeys.message(mailboxId, id)),
    )) as unknown as MessageItem[];
    const byId = new Map(loaded.map((m) => [m.messageUlid, m]));
    for (const id of chunk) {
      examined++;
      const m = byId.get(id);
      // Index entries can outlive a message briefly; skip ones whose message is gone.
      if (m && matchesFilters(m, query)) items.push(m);
      if (items.length === input.limit) break;
    }
  }

  const response: SearchResponse = { items: items.map(toSummary) };
  if (examined < ids.length) {
    const last = ids[examined - 1];
    if (last) response.cursor = last;
  }
  if (matches.some((m) => m.truncated)) response.truncated = true;
  return response;
}
