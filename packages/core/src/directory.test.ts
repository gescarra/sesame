import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveAddresses } from "./directory.ts";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const ddb = mockClient(doc);

const exampleDomain = { pk: "DOMAIN#example.com", sk: "META", domain: "example.com" };
const alice = { pk: "ADDR#alice@example.com", sk: "META", mailboxId: "MBXA" };
const items = [
  exampleDomain,
  { pk: "DOMAIN#catchall.org", sk: "META", domain: "catchall.org", catchAllMailboxId: "MBXC" },
  alice,
  { pk: "ADDR#sales@example.com", sk: "META", mailboxId: "MBXA" },
];

beforeEach(() => {
  ddb.reset();
  ddb.on(BatchGetCommand).callsFake((input) => {
    const keys = input.RequestItems.dir.Keys as { pk: string }[];
    return { Responses: { dir: items.filter((i) => keys.some((k) => k.pk === i.pk)) } };
  });
});

describe("resolveAddresses", () => {
  it("classifies local, alias, catch-all, unknown-local and external addresses", async () => {
    const res = await resolveAddresses(doc, "dir", [
      "Alice@Example.com",
      "sales@example.com",
      "nobody@example.com",
      "anyone@catchall.org",
      "bob@gmail.com",
      "not an address",
    ]);
    expect(res).toEqual([
      { kind: "local", address: "alice@example.com", mailboxId: "MBXA", via: "address" },
      { kind: "local", address: "sales@example.com", mailboxId: "MBXA", via: "address" },
      { kind: "unknown-local", address: "nobody@example.com" },
      { kind: "local", address: "anyone@catchall.org", mailboxId: "MBXC", via: "catch-all" },
      { kind: "external", address: "bob@gmail.com" },
      { kind: "external", address: "not an address" },
    ]);
  });

  it("retries unprocessed keys", async () => {
    ddb
      .on(BatchGetCommand)
      .resolvesOnce({ Responses: { dir: [] }, UnprocessedKeys: { dir: { Keys: [alice] } } })
      .resolves({ Responses: { dir: [exampleDomain, alice] } });
    const res = await resolveAddresses(doc, "dir", ["alice@example.com"]);
    expect(res[0]).toMatchObject({ kind: "local", mailboxId: "MBXA" });
  });
});
