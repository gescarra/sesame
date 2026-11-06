// Read-side directory lookups shared by ingest, the API and the CLI.
import { BatchGetCommand, type DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { domainOf, isValidAddress, normalizeAddress } from "./address.ts";
import { directoryKeys } from "./keys.ts";
import type { AddressItem, DomainItem } from "./types.ts";

export type Resolution =
  | { kind: "local"; address: string; mailboxId: string; via: "address" | "catch-all" }
  | { kind: "unknown-local"; address: string }
  | { kind: "external"; address: string };

/**
 * Classifies one address: a local mailbox, an address at an accepted domain with no
 * mailbox (and no catch-all), or an external address.
 */
export async function resolveAddress(
  doc: DynamoDBDocumentClient,
  table: string,
  input: string,
): Promise<Resolution> {
  return (await resolveAddresses(doc, table, [input]))[0] as Resolution;
}

/** Batch form of resolveAddress. Results are in input order; invalid addresses are external. */
export async function resolveAddresses(
  doc: DynamoDBDocumentClient,
  table: string,
  inputs: string[],
): Promise<Resolution[]> {
  const addresses = inputs.map((a) => (isValidAddress(a) ? normalizeAddress(a) : a));
  const valid = [...new Set(addresses.filter(isValidAddress))];
  const domains = [...new Set(valid.map(domainOf))];

  const items = await batchGet(doc, table, [
    ...valid.map((a) => directoryKeys.address(a)),
    ...domains.map((d) => directoryKeys.domain(d)),
  ]);
  const byPk = new Map(items.map((i) => [i.pk as string, i]));

  return addresses.map((address): Resolution => {
    if (!isValidAddress(address)) return { kind: "external", address };
    const addr = byPk.get(directoryKeys.address(address).pk) as AddressItem | undefined;
    if (addr) return { kind: "local", address, mailboxId: addr.mailboxId, via: "address" };
    const domain = byPk.get(directoryKeys.domain(domainOf(address)).pk) as DomainItem | undefined;
    if (!domain) return { kind: "external", address };
    if (domain.catchAllMailboxId) {
      return { kind: "local", address, mailboxId: domain.catchAllMailboxId, via: "catch-all" };
    }
    return { kind: "unknown-local", address };
  });
}

type Key = { pk: string; sk: string };

/** BatchGetItem with chunking (100 keys) and unprocessed-key retries. */
export async function batchGet(
  doc: DynamoDBDocumentClient,
  table: string,
  keys: Key[],
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    let pending: Key[] = keys.slice(i, i + 100);
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(1000, 50 * 2 ** attempt)));
      if (attempt > 8) throw new Error(`BatchGet on ${table} left ${pending.length} keys unprocessed`);
      const res = await doc.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: pending } } }));
      out.push(...(res.Responses?.[table] ?? []));
      pending = (res.UnprocessedKeys?.[table]?.Keys as Key[] | undefined) ?? [];
    }
  }
  return out;
}

export async function getItem<T>(
  doc: DynamoDBDocumentClient,
  table: string,
  key: Key,
): Promise<T | undefined> {
  const res = await doc.send(new GetCommand({ TableName: table, Key: key }));
  return res.Item as T | undefined;
}
