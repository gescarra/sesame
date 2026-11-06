import { Readable } from "node:stream";
import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { CopyObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { mailKeys } from "@sesame/core";
import { sdkStreamMixin } from "@smithy/util-stream";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { type Deps, deliverJob, MailboxFullError } from "./deliver.ts";
import { multipartMessage, sesNotification } from "./fixtures.ts";
import { parseJob } from "./job.ts";

const s3 = new S3Client({ region: "us-east-1" });
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const s3Mock = mockClient(s3);
const ddbMock = mockClient(doc);
const logs: string[] = [];

const deps: Deps = {
  s3,
  doc,
  mailBucket: "mail",
  mailTable: "mail-table",
  directoryTable: "dir-table",
  log: (level, msg) => logs.push(`${level}: ${msg}`),
};

const directory = [
  { pk: "DOMAIN#example.com", sk: "META" },
  { pk: "ADDR#alice@example.com", sk: "META", mailboxId: "MBXA" },
  { pk: "ADDR#sales@example.com", sk: "META", mailboxId: "MBXA" },
  { pk: "ADDR#bob@example.com", sk: "META", mailboxId: "MBXB" },
];
const mailboxes = new Map<string, { usedBytes?: number; quotaBytes?: number }>();
const messageIdMap = new Map<string, { pk: string; sk: string; threadId: string }>();

function job(overrides: Parameters<typeof sesNotification>[0] = {}) {
  const j = parseJob(JSON.stringify(sesNotification(overrides)));
  if (!j) throw new Error("expected a job");
  return j;
}

function transactItems() {
  return ddbMock.commandCalls(TransactWriteCommand).map((c) => c.args[0].input.TransactItems ?? []);
}

/** The message item written by the first delivery transaction. */
function firstMessage(): Record<string, unknown> {
  return (transactItems()[0]?.[0]?.Put?.Item ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  s3Mock.reset();
  ddbMock.reset();
  logs.length = 0;
  messageIdMap.clear();
  mailboxes.clear();
  mailboxes.set("MBXA", { usedBytes: 0 });
  mailboxes.set("MBXB", { usedBytes: 0, quotaBytes: 1024 * 1024 });

  s3Mock.on(GetObjectCommand).callsFake(() => ({
    Body: sdkStreamMixin(Readable.from([Buffer.from(multipartMessage)])),
  }));
  ddbMock.on(BatchGetCommand).callsFake((input) => {
    const [table, req] = Object.entries(input.RequestItems)[0] as [
      string,
      { Keys: { pk: string; sk: string }[] },
    ];
    const source = table === "dir-table" ? directory : [...messageIdMap.values()];
    return {
      Responses: { [table]: source.filter((i) => req.Keys.some((k) => k.pk === i.pk && k.sk === i.sk)) },
    };
  });
  ddbMock.on(GetCommand).callsFake((input) => {
    if (input.TableName !== "dir-table") return {};
    const id = String(input.Key.pk).replace("MBX#", "");
    const box = mailboxes.get(id);
    return { Item: box ? { pk: input.Key.pk, sk: "META", mailboxId: id, ...box } : undefined };
  });
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(BatchWriteCommand).resolves({});
});

describe("deliverJob", () => {
  it("delivers once per mailbox, including Bcc-only and alias recipients", async () => {
    // bob is only in the envelope (Bcc); alice is addressed directly and through an alias.
    const result = await deliverJob(
      deps,
      job({
        recipients: ["alice@example.com", "sales@example.com", "bob@example.com", "nobody@example.com"],
      }),
    );

    expect(result.deliveries.map((d) => [d.mailboxId, d.outcome])).toEqual([
      ["MBXA", "delivered"],
      ["MBXB", "delivered"],
    ]);
    expect(logs).toContain("info: ignoring non-local recipient");

    const [alice] = transactItems();
    const item = alice?.[0]?.Put?.Item as Record<string, unknown>;
    expect(item).toMatchObject({
      pk: "MBX#MBXA",
      folder: "inbox",
      gsi1pk: "MBX#MBXA#F#inbox",
      subject: "Quarterly report ✅",
      from: { name: "Carol Sender", address: "carol@sender.test" },
      read: false,
      hasAttachments: true,
      messageIdHeader: "<msg-2@sender.test>",
      auth: { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" },
    });
    expect(item.threadId).toBe(item.messageUlid);
    expect(alice?.[1]?.Update?.Key).toEqual({ pk: "MBX#MBXA", sk: "FOLDER#inbox" });
    expect(alice?.[2]?.Update?.ExpressionAttributeValues).toEqual({
      ":size": Buffer.byteLength(multipartMessage),
    });
    expect(alice?.[3]?.Put?.Item).toMatchObject({ type: "message-id", threadId: item.threadId });

    // Search: the token list is on the item, and each token is written for each mailbox.
    expect(item.tokens).toEqual(
      expect.arrayContaining(["quarterly", "report", "carol@sender.test", "sender"]),
    );
    const indexed = ddbMock
      .commandCalls(BatchWriteCommand)
      .flatMap((c) => Object.values(c.args[0].input.RequestItems ?? {}).flat())
      .map((r) => (r as { PutRequest: { Item: { pk: string; sk: string } } }).PutRequest.Item);
    expect(indexed).toContainEqual(
      expect.objectContaining({
        pk: "MBX#MBXA#S#qu",
        sk: `quarterly#${item.messageUlid}`,
        f: new Set(["s"]),
      }),
    );
    expect(indexed.filter((i) => i.pk.startsWith("MBX#MBXB#"))).toHaveLength(
      (item.tokens as string[]).length,
    );

    const prefix = `mbx/MBXA/${item.messageUlid}/`;
    expect(s3Mock.commandCalls(CopyObjectCommand)[0]?.args[0].input).toMatchObject({
      Bucket: "mail",
      Key: `${prefix}message.eml`,
      CopySource: "landing/raw/inbound/ses-abc123",
    });
    const puts = s3Mock.commandCalls(PutObjectCommand).map((c) => c.args[0].input.Key);
    expect(puts).toEqual(expect.arrayContaining([`${prefix}body.json`, `${prefix}att/0`, `${prefix}att/1`]));
  });

  it("files a read Sent copy next to internal deliveries, without ID collisions", async () => {
    const delivery = {
      status: "sending" as const,
      recipients: {
        "bob@example.com": { status: "delivered" as const, at: "t" },
        "x@ext.test": { status: "sending" as const, at: "t" },
      },
      updatedAt: "t",
    };
    // alice sends to bob and to herself.
    const internal = {
      source: "internal" as const,
      id: "out-1",
      bucket: "mail",
      key: "raw/outbound/out-1.eml",
      recipients: ["bob@example.com", "alice@example.com"],
      receivedAt: "2026-10-28T10:00:00.000Z",
      sentCopy: { mailboxId: "MBXA", delivery },
    };
    const result = await deliverJob(deps, internal);
    expect(result.deliveries.map((d) => [d.mailboxId, d.outcome, d.sent ?? false])).toEqual([
      ["MBXB", "delivered", false],
      ["MBXA", "delivered", false],
      ["MBXA", "delivered", true],
    ]);
    const ids = result.deliveries.map((d) => d.messageUlid);
    expect(new Set(ids).size).toBe(3);

    const sent = transactItems()[2];
    expect(sent?.[0]?.Put?.Item).toMatchObject({
      folder: "sent",
      gsi1pk: "MBX#MBXA#F#sent",
      read: true,
      delivery,
    });
    expect(sent?.[0]?.Put?.Item).not.toHaveProperty("auth");
    expect(sent?.[1]?.Update?.Key).toEqual({ pk: "MBX#MBXA", sk: "FOLDER#sent" });
    expect(sent?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({ ":one": 1, ":unread": 0 });
    expect(transactItems()[0]?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({ ":unread": 1 });
  });

  it("files only the Sent copy when every recipient is external", async () => {
    const result = await deliverJob(deps, {
      source: "internal",
      id: "out-2",
      bucket: "mail",
      key: "raw/outbound/out-2.eml",
      recipients: [],
      receivedAt: "2026-10-28T10:00:00.000Z",
      sentCopy: { mailboxId: "MBXA", delivery: { status: "sending", recipients: {}, updatedAt: "t" } },
    });
    expect(result.deliveries.map((d) => [d.mailboxId, d.sent])).toEqual([["MBXA", true]]);
  });

  it("is idempotent: the same job produces the same message IDs", async () => {
    const a = await deliverJob(deps, job());
    const b = await deliverJob(deps, job());
    expect(b.deliveries[0]?.messageUlid).toBe(a.deliveries[0]?.messageUlid);
  });

  it("skips S3 writes when the message already exists", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { pk: "x" } });
    const result = await deliverJob(deps, job());
    expect(result.deliveries[0]?.outcome).toBe("duplicate");
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it("treats a failed message condition as a duplicate", async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: "cancelled",
        $metadata: {},
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }],
      }),
    );
    expect((await deliverJob(deps, job())).deliveries[0]?.outcome).toBe("duplicate");
  });

  it("joins the parent's thread", async () => {
    messageIdMap.set("parent", {
      pk: "MBX#MBXA",
      sk: mailKeys.messageIdMap("MBXA", "<msg-1@example.com>").sk,
      threadId: "THREAD1",
    });
    await deliverJob(deps, job());
    const item = firstMessage();
    expect(item.threadId).toBe("THREAD1");
    expect(item.gsi2pk).toBe("MBX#MBXA#T#THREAD1");
  });

  it("files spam in junk and drops viruses", async () => {
    await deliverJob(deps, job({ spam: "FAIL" }));
    expect(firstMessage().folder).toBe("junk");

    const result = await deliverJob(deps, job({ virus: "FAIL" }));
    expect(result.dropped).toBe("virus");
  });

  it("holds mail for a full mailbox and still delivers to the others", async () => {
    mailboxes.set("MBXB", { usedBytes: 1024 * 1024, quotaBytes: 1024 * 1024 });
    const err = await deliverJob(deps, job({ recipients: ["alice@example.com", "bob@example.com"] })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MailboxFullError);
    expect((err as MailboxFullError).mailboxIds).toEqual(["MBXB"]);
    // Only alice's delivery was written; bob's mailbox got no objects.
    expect(transactItems().map((t) => t[0]?.Put?.Item?.pk)).toEqual(["MBX#MBXA"]);
    const keys = s3Mock.commandCalls(PutObjectCommand).map((c) => c.args[0].input.Key ?? "");
    expect(keys.some((k) => k.startsWith("mbx/MBXB/"))).toBe(false);
    expect(logs).toContain("warn: delivery over-quota");
  });

  it("guards the quota in the delivery transaction", async () => {
    await deliverJob(deps, job());
    const update = transactItems()[0]?.[2]?.Update;
    expect(update?.ConditionExpression).toContain("usedBytes < quotaBytes");

    // The mailbox filled up between the check and the write.
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: "cancelled",
        $metadata: {},
        CancellationReasons: [
          { Code: "None" },
          { Code: "None" },
          { Code: "ConditionalCheckFailed", Item: {} },
        ],
      }),
    );
    await expect(deliverJob(deps, job())).rejects.toBeInstanceOf(MailboxFullError);
  });

  it("files a Sent copy even when the sender's mailbox is full", async () => {
    mailboxes.set("MBXA", { usedBytes: 2048, quotaBytes: 1024 });
    const result = await deliverJob(deps, {
      source: "internal",
      id: "out-3",
      bucket: "mail",
      key: "raw/outbound/out-3.eml",
      recipients: [],
      receivedAt: "2026-10-28T10:00:00.000Z",
      sentCopy: { mailboxId: "MBXA", delivery: { status: "sending", recipients: {}, updatedAt: "t" } },
    });
    expect(result.deliveries).toEqual([expect.objectContaining({ outcome: "delivered", sent: true })]);
    expect(transactItems()[0]?.[2]?.Update?.ConditionExpression).toBe("attribute_exists(pk)");
  });

  it("drops mail for a mailbox that no longer exists", async () => {
    mailboxes.delete("MBXA");
    const result = await deliverJob(deps, job());
    expect(result.deliveries[0]?.outcome).toBe("mailbox-missing");
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it("drops mail with no local recipients without reading it", async () => {
    const result = await deliverJob(deps, job({ recipients: ["nobody@example.com"] }));
    expect(result.dropped).toBe("no-local-recipients");
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });
});
