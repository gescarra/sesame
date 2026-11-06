import { Readable } from "node:stream";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { directoryKeys, type MessageItem, mailKeys } from "@sesame/core";
import { sdkStreamMixin } from "@smithy/util-stream";
import { beforeEach, describe, expect, it } from "vitest";
import { counterDeltas, decodeCursor, encodeCursor } from "./mail.ts";
import { contentDisposition } from "./routes.ts";
import {
  ddbMock,
  MBX,
  MSG,
  message,
  s3Mock,
  sessionCookie,
  type TestDeps,
  testApp,
  testDeps,
} from "./testing.ts";

let deps: TestDeps;
let app: ReturnType<typeof testApp>;
let stored: Map<string, MessageItem>;

const member = {
  ...directoryKeys.member(MBX, "alice@example.com"),
  type: "member",
  mailboxId: MBX,
  role: "owner",
};

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", sessionCookie(deps));
  if (init.method && init.method !== "GET") headers.set("x-requested-with", "sesame");
  if (init.body) headers.set("content-type", "application/json");
  return app.request(`/api/mailboxes/${MBX}${path}`, { ...init, headers });
}

function transactItems() {
  return ddbMock.commandCalls(TransactWriteCommand).map((c) => c.args[0].input.TransactItems ?? []);
}

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  deps = testDeps();
  app = testApp(deps);
  stored = new Map([[MSG, message()]]);

  ddbMock.on(GetCommand).callsFake((input) => {
    if (input.TableName === "dir-table") {
      return { Item: input.Key.pk === member.pk && input.Key.sk === member.sk ? member : undefined };
    }
    const id = String(input.Key.sk).replace("MSG#", "");
    return { Item: stored.get(id) };
  });
  ddbMock.on(TransactWriteCommand).resolves({});
});

describe("helpers", () => {
  it("computes counter deltas for read changes and moves", () => {
    expect(counterDeltas({ read: false, folder: "inbox" }, { read: true, folder: "inbox" })).toEqual([
      ["inbox", 0, -1],
    ]);
    expect(counterDeltas({ read: false, folder: "inbox" }, { read: false, folder: "archive" })).toEqual([
      ["inbox", -1, -1],
      ["archive", 1, 1],
    ]);
    expect(counterDeltas({ read: true, folder: "inbox" }, { read: false, folder: "trash" })).toEqual([
      ["inbox", -1, 0],
      ["trash", 1, 1],
    ]);
    expect(counterDeltas({ read: true, folder: "inbox" }, { read: true, folder: "inbox" })).toEqual([]);
  });

  it("only accepts cursors for the expected partition", () => {
    const key = { pk: `MBX#${MBX}`, sk: `MSG#${MSG}`, gsi1pk: `MBX#${MBX}#F#inbox`, gsi1sk: MSG };
    const cursor = encodeCursor(key);
    expect(decodeCursor(cursor, { pk: `MBX#${MBX}`, gsi1pk: `MBX#${MBX}#F#inbox` })).toEqual(key);
    expect(() => decodeCursor(cursor, { pk: "MBX#OTHER", gsi1pk: "MBX#OTHER#F#inbox" })).toThrow(
      "invalid cursor",
    );
    expect(() => decodeCursor("not-json", { pk: "x" })).toThrow("invalid cursor");
  });

  it("encodes filenames for Content-Disposition", () => {
    expect(contentDisposition("attachment", 'résumé "final".pdf')).toBe(
      `attachment; filename="r_sum_ _final_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`,
    );
    expect(contentDisposition("inline", "it's (1).png")).toBe(
      `inline; filename="it's (1).png"; filename*=UTF-8''it%27s%20%281%29.png`,
    );
  });
});

describe("GET /api/health", () => {
  it("answers without a session or config", async () => {
    const res = await testApp(testDeps()).request("/api/health");
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /api/me", () => {
  it("lists the user's mailboxes", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [member] });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        "dir-table": [
          {
            ...directoryKeys.mailbox(MBX),
            mailboxId: MBX,
            primaryAddress: "alice@example.com",
            usedBytes: 512,
            quotaBytes: 1024,
          },
        ],
      },
    });
    const res = await app.request("/api/me", { headers: { cookie: sessionCookie(deps) } });
    expect(await res.json()).toEqual({
      email: "alice@example.com",
      name: "Alice",
      mailboxes: [
        { mailboxId: MBX, address: "alice@example.com", role: "owner", usedBytes: 512, quotaBytes: 1024 },
      ],
    });
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.ExpressionAttributeValues).toEqual({
      ":u": "USER#alice@example.com",
    });
  });
});

describe("mailbox access", () => {
  it("hides mailboxes the user is not a member of", async () => {
    const res = await app.request("/api/mailboxes/01M5ZJ2GVN042RKXX2HW200C0R/folders", {
      headers: { cookie: sessionCookie(deps) },
    });
    expect(res.status).toBe(404);
    const bad = await app.request("/api/mailboxes/not-a-ulid/folders", {
      headers: { cookie: sessionCookie(deps) },
    });
    expect(bad.status).toBe(404);
  });
});

describe("GET folders", () => {
  it("returns every system folder with counts", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { ...mailKeys.folderCounter(MBX, "inbox"), total: 3, unread: 2 },
        { ...mailKeys.folderCounter(MBX, "junk"), total: 1, unread: -1 },
      ],
    });
    const res = await request("/folders");
    expect(await res.json()).toEqual({
      folders: [
        { name: "inbox", total: 3, unread: 2 },
        { name: "sent", total: 0, unread: 0 },
        { name: "junk", total: 1, unread: 0 },
        { name: "trash", total: 0, unread: 0 },
        { name: "archive", total: 0, unread: 0 },
      ],
    });
  });
});

describe("GET messages", () => {
  it("pages a folder newest first", async () => {
    const lastKey = { pk: `MBX#${MBX}`, sk: `MSG#${MSG}`, gsi1pk: `MBX#${MBX}#F#inbox`, gsi1sk: MSG };
    ddbMock.on(QueryCommand).resolves({ Items: [message()], LastEvaluatedKey: lastKey });
    const res = await request("/messages?limit=1");
    const body = (await res.json()) as { items: { id: string; subject: string }[]; cursor: string };
    expect(body.items.map((m) => [m.id, m.subject])).toEqual([[MSG, "Hello"]]);
    expect(body.items[0]).not.toHaveProperty("objectPrefix");
    expect(decodeCursor(body.cursor, { pk: `MBX#${MBX}` })).toEqual(lastKey);

    const input = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ IndexName: "gsi1", ScanIndexForward: false, Limit: 1 });
    expect(input?.ExpressionAttributeValues).toEqual({ ":p": `MBX#${MBX}#F#inbox` });
  });

  it("refills filtered pages for unread only", async () => {
    const key = (n: number) => ({
      pk: `MBX#${MBX}`,
      sk: `MSG#${n}`,
      gsi1pk: `MBX#${MBX}#F#junk`,
      gsi1sk: `${n}`,
    });
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [], LastEvaluatedKey: key(1) })
      .resolvesOnce({ Items: [message({ folder: "junk" })], LastEvaluatedKey: key(2) })
      .resolves({ Items: [message({ folder: "junk" })] });
    const res = await request("/messages?folder=junk&unread=1&limit=2");
    const body = (await res.json()) as { items: unknown[]; cursor?: string };
    expect(body.items).toHaveLength(2);
    expect(body.cursor).toBeUndefined();
    const calls = ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(calls.map((c) => c.Limit)).toEqual([2, 2, 1]);
    expect(calls[0]?.FilterExpression).toBe("#read = :false");
    expect(calls[1]?.ExclusiveStartKey).toEqual(key(1));
  });

  it("lists flagged messages through the sparse index", async () => {
    const flagged = message({ flagged: true });
    ddbMock.on(QueryCommand).resolves({ Items: [{ pk: flagged.pk, sk: flagged.sk }] });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { "mail-table": [flagged] } });
    const res = await request("/messages?flagged=1");
    const body = (await res.json()) as { items: { id: string; flagged: boolean }[] };
    expect(body.items).toEqual([expect.objectContaining({ id: MSG, flagged: true })]);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.IndexName).toBe("gsi3");
  });

  it("validates parameters", async () => {
    expect((await request("/messages?folder=drafts")).status).toBe(400);
    expect((await request("/messages?limit=1000")).status).toBe(400);
    expect((await request(`/messages?cursor=${encodeCursor({ pk: "MBX#OTHER" })}`)).status).toBe(400);
  });
});

describe("GET a message", () => {
  it("returns metadata and the stored body", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Readable.from([Buffer.from('{"text":"Hi","html":"<p>Hi</p>"}')])),
    });
    const res = await request(`/messages/${MSG}`);
    const body = (await res.json()) as { message: Record<string, unknown>; body: unknown };
    expect(body.body).toEqual({ text: "Hi", html: "<p>Hi</p>" });
    expect(body.message).toMatchObject({ id: MSG, subject: "Hello", messageIdHeader: "<m1@example.org>" });
    expect(body.message.attachments).toHaveLength(3);
    expect(s3Mock.commandCalls(GetObjectCommand)[0]?.args[0].input.Key).toBe(`mbx/${MBX}/${MSG}/body.json`);
  });

  it("is 404 for unknown or malformed ids", async () => {
    expect((await request("/messages/01M5ZJ32HDGDRJ5084ESAB24RX")).status).toBe(404);
    expect((await request("/messages/nope")).status).toBe(404);
  });
});

describe("PATCH a message", () => {
  it("marks read and decrements the unread counter in one transaction", async () => {
    const res = await request(`/messages/${MSG}`, { method: "PATCH", body: JSON.stringify({ read: true }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { message: { read: boolean } }).message.read).toBe(true);

    const [items] = transactItems();
    expect(items?.[0]?.Update?.ConditionExpression).toBe(
      "attribute_exists(pk) AND #read = :curRead AND #folder = :curFolder",
    );
    expect(items?.[0]?.Update?.ExpressionAttributeValues).toMatchObject({ ":read": true, ":curRead": false });
    expect(items?.[1]?.Update?.Key).toEqual(mailKeys.folderCounter(MBX, "inbox"));
    expect(items?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({ ":total": 0, ":unread": -1 });
    expect(items).toHaveLength(2);
  });

  it("flags through the sparse index without touching counters", async () => {
    await request(`/messages/${MSG}`, { method: "PATCH", body: JSON.stringify({ flagged: true }) });
    const [items] = transactItems();
    expect(items).toHaveLength(1);
    expect(items?.[0]?.Update?.UpdateExpression).toContain("gsi3pk = :gsi3pk");
    expect(items?.[0]?.Update?.ExpressionAttributeValues?.[":gsi3pk"]).toBe(`MBX#${MBX}#FLAGGED`);

    stored.set(MSG, message({ flagged: true }));
    ddbMock.resetHistory();
    await request(`/messages/${MSG}`, { method: "PATCH", body: JSON.stringify({ flagged: false }) });
    expect(transactItems()[0]?.[0]?.Update?.UpdateExpression).toContain("REMOVE gsi3pk, gsi3sk");
  });

  it("moves between folders and updates both counters", async () => {
    await request(`/messages/${MSG}`, { method: "PATCH", body: JSON.stringify({ folder: "archive" }) });
    const [items] = transactItems();
    expect(items?.[0]?.Update?.ExpressionAttributeValues?.[":gsi1pk"]).toBe(`MBX#${MBX}#F#archive`);
    expect(items?.slice(1).map((i) => [i.Update?.Key?.sk, i.Update?.ExpressionAttributeValues])).toEqual([
      ["FOLDER#inbox", expect.objectContaining({ ":total": -1, ":unread": -1 })],
      ["FOLDER#archive", expect.objectContaining({ ":total": 1, ":unread": 1 })],
    ]);
  });

  it("skips the write when nothing changes", async () => {
    const res = await request(`/messages/${MSG}`, { method: "PATCH", body: JSON.stringify({ read: false }) });
    expect(res.status).toBe(200);
    expect(transactItems()).toHaveLength(0);
  });

  it("retries after a concurrent change", async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejectsOnce(
        new TransactionCanceledException({
          message: "cancelled",
          $metadata: {},
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
        }),
      )
      .resolves({});
    const res = await request(`/messages/${MSG}`, { method: "PATCH", body: JSON.stringify({ read: true }) });
    expect(res.status).toBe(200);
    expect(transactItems()).toHaveLength(2);
  });

  it("rejects bad bodies", async () => {
    for (const body of ["{}", '{"read":"yes"}', '{"folder":"drafts"}', "[]", "nope"]) {
      expect((await request(`/messages/${MSG}`, { method: "PATCH", body })).status).toBe(400);
    }
  });
});

describe("DELETE a message", () => {
  it("moves messages outside trash to trash", async () => {
    const res = await request(`/messages/${MSG}`, { method: "DELETE" });
    expect(await res.json()).toEqual({ result: "trashed" });
    expect(transactItems()[0]?.[0]?.Update?.ExpressionAttributeValues?.[":folder"]).toBe("trash");
  });

  it("purges messages in trash, with their counters, quota and objects", async () => {
    stored.set(MSG, message({ folder: "trash", read: true }));
    ddbMock.on(DeleteCommand).resolves({});
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: `mbx/${MBX}/${MSG}/message.eml` }, { Key: `mbx/${MBX}/${MSG}/body.json` }],
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const res = await request(`/messages/${MSG}`, { method: "DELETE" });
    expect(await res.json()).toEqual({ result: "purged" });

    const [items] = transactItems();
    expect(items?.[0]?.Delete?.Key).toEqual(mailKeys.message(MBX, MSG));
    expect(items?.[1]?.Update?.ExpressionAttributeValues).toEqual({ ":total": -1, ":unread": 0 });
    expect(items?.[2]?.Update).toMatchObject({
      TableName: "dir-table",
      Key: directoryKeys.mailbox(MBX),
      ExpressionAttributeValues: { ":size": -1234 },
    });
    expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input.Key).toEqual(
      mailKeys.messageIdMap(MBX, "<m1@example.org>"),
    );
    expect(s3Mock.commandCalls(ListObjectsV2Command)[0]?.args[0].input.Prefix).toBe(`mbx/${MBX}/${MSG}/`);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)[0]?.args[0].input.Delete?.Objects).toHaveLength(2);
  });
});

describe("POST messages/batch", () => {
  it("applies an action to each id and reports per-id results", async () => {
    const res = await request("/messages/batch", {
      method: "POST",
      body: JSON.stringify({ ids: [MSG, "01M5ZJ32HDGDRJ5084ESAB24RX"], action: "move", folder: "archive" }),
    });
    expect(await res.json()).toEqual({
      results: [
        { id: MSG, ok: true },
        { id: "01M5ZJ32HDGDRJ5084ESAB24RX", ok: false, error: "message not found" },
      ],
    });
  });

  it("validates the request", async () => {
    const bad = [
      { ids: [], action: "read" },
      { ids: ["x"], action: "read" },
      { ids: [MSG], action: "explode" },
      { ids: [MSG], action: "move", folder: "nowhere" },
    ];
    for (const body of bad) {
      expect((await request("/messages/batch", { method: "POST", body: JSON.stringify(body) })).status).toBe(
        400,
      );
    }
  });
});

describe("downloads", () => {
  it("redirects attachments to a short-lived presigned URL", async () => {
    const res = await request(`/messages/${MSG}/attachments/1`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `https://mail-bucket.s3.amazonaws.com/mbx/${MBX}/${MSG}/att/1?X-Amz-Expires=300`,
    );
    expect(deps.presigned[0]).toEqual({
      key: `mbx/${MBX}/${MSG}/att/1`,
      disposition: contentDisposition("attachment", 'résumé "final".pdf'),
      type: "application/octet-stream",
    });
  });

  it("serves raster images inline on request, but never SVG", async () => {
    await request(`/messages/${MSG}/attachments/0?inline=1`);
    await request(`/messages/${MSG}/attachments/2?inline=1`);
    expect(deps.presigned.map((p) => [p.disposition?.split(";")[0], p.type])).toEqual([
      ["inline", "image/png"],
      ["attachment", "application/octet-stream"],
    ]);
  });

  it("returns the presigned URL as JSON on request", async () => {
    const res = await request(`/messages/${MSG}/attachments/0?inline=1&as=url`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: `https://mail-bucket.s3.amazonaws.com/mbx/${MBX}/${MSG}/att/0?X-Amz-Expires=300`,
      expiresIn: 300,
    });
    expect(deps.presigned[0]?.disposition).toMatch(/^inline;/);
  });

  it("downloads the raw message", async () => {
    const res = await request(`/messages/${MSG}/raw`);
    expect(res.status).toBe(302);
    expect(deps.presigned[0]).toMatchObject({ key: `mbx/${MBX}/${MSG}/message.eml`, type: "message/rfc822" });
  });

  it("is 404 for unknown parts", async () => {
    expect((await request(`/messages/${MSG}/attachments/9`)).status).toBe(404);
  });
});

describe("GET a thread", () => {
  it("returns the thread's messages in order", async () => {
    const reply = message({ messageUlid: "01M5ZJ98JJV1SKV8DGM4JGBZDG", threadId: MSG });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { pk: `MBX#${MBX}`, sk: `MSG#${MSG}` },
        { pk: `MBX#${MBX}`, sk: `MSG#${reply.messageUlid}` },
      ],
    });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { "mail-table": [reply, message()] } });
    const res = await request(`/threads/${MSG}`);
    const body = (await res.json()) as { messages: { id: string }[] };
    expect(body.messages.map((m) => m.id)).toEqual([MSG, reply.messageUlid]);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.IndexName).toBe("gsi2");
  });

  it("is 404 for an empty thread", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    expect((await request(`/threads/${MSG}`)).status).toBe(404);
  });
});
