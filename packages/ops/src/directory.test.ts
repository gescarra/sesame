import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addAlias,
  addMailbox,
  type Ctx,
  deleteMailbox,
  planMailboxDeletion,
  setQuota,
  UserError,
} from "./directory.ts";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const ddb = mockClient(doc);
const ctx: Ctx = { doc, table: "dir" };

function cancelled(codes: string[]) {
  return new TransactionCanceledException({
    message: "cancelled",
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

beforeEach(() => {
  ddb.reset();
  ddb.on(TransactWriteCommand).resolves({});
});

describe("addMailbox", () => {
  it("writes the address, mailbox and owner membership atomically, guarded by the domain", async () => {
    const mbx = await addMailbox(ctx, "Alice@Example.com", { displayName: "Alice", quotaMb: 10 });
    const items = ddb.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];

    expect(items[0]?.ConditionCheck?.Key).toEqual({ pk: "DOMAIN#example.com", sk: "META" });
    expect(items[1]?.Put?.Item).toMatchObject({
      pk: "ADDR#alice@example.com",
      kind: "primary",
      mailboxId: mbx.mailboxId,
    });
    expect(items[2]?.Put?.Item).toMatchObject({
      pk: `MBX#${mbx.mailboxId}`,
      sk: "META",
      primaryAddress: "alice@example.com",
      quotaBytes: 10 * 1024 * 1024,
    });
    expect(items[3]?.Put?.Item).toMatchObject({ sk: "MEMBER#alice@example.com", role: "owner" });
  });

  it("explains which condition failed", async () => {
    ddb.on(TransactWriteCommand).rejects(cancelled(["ConditionalCheckFailed", "None", "None", "None"]));
    await expect(addMailbox(ctx, "alice@unknown.test")).rejects.toThrow(
      /unknown.test is not in the directory/,
    );

    ddb.on(TransactWriteCommand).rejects(cancelled(["None", "ConditionalCheckFailed", "None", "None"]));
    await expect(addMailbox(ctx, "alice@example.com")).rejects.toThrow(/already in use/);
  });
});

describe("addAlias", () => {
  it("points the alias at the target's mailbox", async () => {
    ddb
      .on(GetCommand)
      .resolves({ Item: { pk: "ADDR#alice@example.com", address: "alice@example.com", mailboxId: "MBXA" } });
    const alias = await addAlias(ctx, "sales@example.com", "alice@example.com");
    expect(alias).toMatchObject({ pk: "ADDR#sales@example.com", mailboxId: "MBXA", kind: "alias" });
  });

  it("rejects unknown targets", async () => {
    ddb.on(GetCommand).resolves({});
    await expect(addAlias(ctx, "sales@example.com", "ghost@example.com")).rejects.toThrow(UserError);
  });
});

describe("setQuota", () => {
  it("sets and removes a mailbox's quota by any of its addresses", async () => {
    ddb.on(GetCommand).resolves({ Item: { mailboxId: "MBXA" } });
    ddb.on(UpdateCommand).resolves({ Attributes: { primaryAddress: "alice@example.com" } });
    await setQuota(ctx, "Sales@Example.com", 50);
    await setQuota(ctx, "sales@example.com", null);
    const [set, remove] = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(set).toMatchObject({
      Key: { pk: "MBX#MBXA", sk: "META" },
      UpdateExpression: "SET quotaBytes = :q",
      ExpressionAttributeValues: { ":q": 50 * 1024 * 1024 },
    });
    expect(remove?.UpdateExpression).toBe("REMOVE quotaBytes");
  });

  it("refuses unknown addresses", async () => {
    ddb.on(GetCommand).resolves({});
    await expect(setQuota(ctx, "nobody@example.com", 1)).rejects.toBeInstanceOf(UserError);
  });
});

describe("deleteMailbox", () => {
  const MBX = "01M5ZJ2GVN042RKXX2HW200C0Q";
  const items: Record<string, unknown>[] = [
    { pk: "DOMAIN#example.com", sk: "META", type: "domain", domain: "example.com", catchAllMailboxId: MBX },
    { pk: "DOMAIN#other.test", sk: "META", type: "domain", domain: "other.test" },
    {
      pk: "ADDR#alice@example.com",
      sk: "META",
      type: "address",
      address: "alice@example.com",
      mailboxId: MBX,
    },
    {
      pk: "ADDR#sales@example.com",
      sk: "META",
      type: "address",
      address: "sales@example.com",
      mailboxId: MBX,
    },
    {
      pk: "ADDR#bob@example.com",
      sk: "META",
      type: "address",
      address: "bob@example.com",
      mailboxId: "OTHER",
    },
    {
      pk: `MBX#${MBX}`,
      sk: "MEMBER#alice@example.com",
      type: "member",
      mailboxId: MBX,
      userId: "alice@example.com",
    },
  ];

  it("removes the mailbox, its addresses, members and catch-all in one transaction, leaving a purge marker", async () => {
    ddb.on(GetCommand).resolves({
      Item: { pk: `MBX#${MBX}`, sk: "META", mailboxId: MBX, primaryAddress: "alice@example.com" },
    });
    ddb.on(ScanCommand).callsFake((input) => ({
      Items: items.filter((i) => i.type === input.ExpressionAttributeValues?.[":type"]),
    }));
    const plan = await planMailboxDeletion(ctx, MBX);
    expect(plan.addresses.map((a) => a.address)).toEqual(["alice@example.com", "sales@example.com"]);
    expect(plan.catchAllDomains).toEqual(["example.com"]);

    const marker = await deleteMailbox(ctx, plan, "root@example.com", Date.parse("2026-10-28T12:00:00Z"));
    expect(marker).toMatchObject({
      pk: `PURGE#${MBX}`,
      address: "alice@example.com",
      requestedBy: "root@example.com",
    });
    const tx = ddb.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(tx.map((t) => t.Delete?.Key ?? t.Update?.Key ?? { pk: t.Put?.Item?.pk })).toEqual([
      { pk: `MBX#${MBX}`, sk: "META" },
      { pk: "ADDR#alice@example.com", sk: "META" },
      { pk: "ADDR#sales@example.com", sk: "META" },
      { pk: `MBX#${MBX}`, sk: "MEMBER#alice@example.com" },
      { pk: "DOMAIN#example.com", sk: "META" },
      { pk: `PURGE#${MBX}` },
    ]);
    // Addresses are only removed while they still point at this mailbox.
    expect(tx[1]?.Delete?.ConditionExpression).toBe("mailboxId = :id");
  });

  it("explains a concurrent change instead of failing", async () => {
    ddb.on(TransactWriteCommand).rejects(cancelled(["ConditionalCheckFailed"]));
    const plan = {
      mailbox: {
        pk: `MBX#${MBX}`,
        sk: "META",
        type: "mailbox",
        mailboxId: MBX,
        primaryAddress: "a@example.com",
        createdAt: "",
      },
      addresses: [],
      members: [],
      catchAllDomains: [],
    } as const;
    await expect(
      deleteMailbox(ctx, { ...plan, addresses: [], members: [], catchAllDomains: [] }, "x"),
    ).rejects.toBeInstanceOf(UserError);
  });
});
