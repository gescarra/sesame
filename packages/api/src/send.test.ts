import { Readable } from "node:stream";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { BatchGetCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeliveryJob, SendJob } from "@sesame/core";
import { directoryKeys } from "@sesame/core";
import { sdkStreamMixin } from "@smithy/util-stream";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ddbMock,
  MBX,
  MSG,
  message,
  s3Mock,
  sessionCookie,
  sqsMock,
  type TestDeps,
  testApp,
  testDeps,
} from "./testing.ts";

const MBXB = "01M5ZJ2GVN042RKXX2HW200C0R";
const UPLOAD = "01M5ZJ98JJV1SKV8DGM4JGBZDG";

const directory: Record<string, unknown>[] = [
  { ...directoryKeys.domain("example.com"), domain: "example.com" },
  { ...directoryKeys.address("alice@example.com"), mailboxId: MBX, kind: "primary" },
  { ...directoryKeys.address("hello@example.com"), mailboxId: MBX, kind: "alias" },
  { ...directoryKeys.address("bob@example.com"), mailboxId: MBXB, kind: "primary" },
  { ...directoryKeys.suppression("gone@ext.test"), address: "gone@ext.test", reason: "bounce" },
];
const mailbox = {
  ...directoryKeys.mailbox(MBX),
  mailboxId: MBX,
  primaryAddress: "alice@example.com",
  displayName: "Alice",
};
const member = { ...directoryKeys.member(MBX, "alice@example.com"), mailboxId: MBX, role: "owner" };

let deps: TestDeps;
let app: ReturnType<typeof testApp>;

function post(path: string, body: unknown) {
  return app.request(`/api${path}`, {
    method: "POST",
    headers: {
      cookie: sessionCookie(deps),
      "x-requested-with": "sesame",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const send = (body: unknown) => post(`/mailboxes/${MBX}/send`, body);

function rawMime(): string {
  const put = s3Mock.commandCalls(PutObjectCommand)[0]?.args[0].input;
  return Buffer.from(put?.Body as Buffer).toString("utf8");
}

function queued<T>(queue: string): T[] {
  return sqsMock
    .commandCalls(SendMessageCommand)
    .filter((c) => c.args[0].input.QueueUrl === queue)
    .map((c) => JSON.parse(c.args[0].input.MessageBody ?? "{}") as T);
}

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  sqsMock.reset();
  deps = testDeps();
  app = testApp(deps);

  ddbMock.on(GetCommand).callsFake((input) => {
    const key = input.Key as { pk: string; sk: string };
    if (input.TableName === "dir-table") {
      if (key.pk === member.pk && key.sk === member.sk) return { Item: member };
      if (key.pk === mailbox.pk && key.sk === mailbox.sk) return { Item: mailbox };
      return {};
    }
    if (key.sk === `MSG#${MSG}`) {
      return { Item: message({ messageIdHeader: "<orig@example.org>", references: ["<root@example.org>"] }) };
    }
    return {};
  });
  ddbMock.on(BatchGetCommand).callsFake((input) => {
    const [table, req] = Object.entries(input.RequestItems)[0] as [
      string,
      { Keys: { pk: string; sk: string }[] },
    ];
    return {
      Responses: { [table]: directory.filter((i) => req.Keys.some((k) => k.pk === i.pk && k.sk === i.sk)) },
    };
  });
  ddbMock.on(UpdateCommand).resolves({});
  s3Mock.on(PutObjectCommand).resolves({});
  s3Mock.on(GetObjectCommand).callsFake((input) => ({
    Body: sdkStreamMixin(Readable.from([Buffer.from(`content of ${input.Key}`)])),
  }));
  sqsMock.on(SendMessageCommand).resolves({});
});

describe("POST /api/uploads", () => {
  it("returns a presigned POST into the user's staging prefix", async () => {
    let options: Parameters<TestDeps["presignPost"]>[0] | undefined;
    deps.presignPost = async (o) => {
      options = o;
      return { url: "https://bucket/", fields: { key: o.Key } };
    };
    const res = await post("/uploads", { filename: "a.pdf", contentType: "application/pdf", size: 1000 });
    const body = (await res.json()) as { uploadId: string; maxBytes: number };
    expect(res.status).toBe(200);
    expect(options?.Key).toBe(`staging/sub-alice/${body.uploadId}`);
    expect(options?.Conditions).toEqual([
      ["content-length-range", 1, 20 * 1024 * 1024],
      ["eq", "$Content-Type", "application/pdf"],
    ]);
    expect(body.maxBytes).toBe(20 * 1024 * 1024);
  });

  it("rejects oversized or nameless uploads", async () => {
    expect(
      (await post("/uploads", { filename: "a", contentType: "text/plain", size: 21 * 1024 * 1024 })).status,
    ).toBe(400);
    expect((await post("/uploads", { filename: "", contentType: "text/plain", size: 1 })).status).toBe(400);
  });
});

describe("POST /api/mailboxes/:mbx/send", () => {
  it("routes local recipients through ingest and the rest through the sender", async () => {
    const res = await send({
      to: ["Bob@Example.com", "carol@ext.test"],
      cc: ["dan@ext.test"],
      bcc: ["hidden@ext.test", "alice@example.com"],
      subject: "Plans",
      text: "See attached.",
      attachments: [{ uploadId: UPLOAD, filename: "plan.txt", contentType: "text/plain" }],
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { sentId: string; internal: number; external: number };
    expect(body).toMatchObject({ internal: 2, external: 3 });

    const mime = rawMime();
    expect(mime).toMatch(/^From: Alice <alice@example\.com>$/m);
    expect(mime).toMatch(/^To: bob@example\.com, carol@ext\.test$/m);
    expect(mime).toMatch(/^Cc: dan@ext\.test$/m);
    expect(mime).not.toMatch(/^Bcc:/im);
    expect(mime).not.toContain("hidden@ext.test");
    expect(mime).toMatch(/^Message-ID: <[0-9a-z]{26}@example\.com>$/m);
    expect(mime).toContain("filename=plan.txt");
    expect(s3Mock.commandCalls(GetObjectCommand)[0]?.args[0].input.Key).toBe(`staging/sub-alice/${UPLOAD}`);

    const [ingest] = queued<DeliveryJob>("https://sqs/ingest");
    expect(ingest).toMatchObject({
      source: "internal",
      bucket: "mail-bucket",
      recipients: ["bob@example.com", "alice@example.com"],
      sentCopy: { mailboxId: MBX },
    });
    expect(ingest?.key).toMatch(/^raw\/outbound\/[0-9A-Z]{26}\.eml$/);
    expect(ingest?.sentCopy?.delivery.status).toBe("sending");
    expect(ingest?.sentCopy?.delivery.recipients["bob@example.com"]?.status).toBe("delivered");
    expect(ingest?.sentCopy?.delivery.recipients["hidden@ext.test"]?.status).toBe("sending");

    const [job] = queued<SendJob>("https://sqs/send");
    expect(job).toMatchObject({
      from: "alice@example.com",
      destinations: ["carol@ext.test", "dan@ext.test", "hidden@ext.test"],
      mailboxId: MBX,
      sentUlid: body.sentId,
      key: ingest?.key,
    });

    const rate = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(rate?.Key?.pk).toMatch(/^RATE#sub-alice#2026-10-27T12$/);
  });

  it("doesn't use SES when every recipient is local", async () => {
    const res = await send({ to: ["bob@example.com"], subject: "Hi", text: "Hi" });
    expect(res.status).toBe(202);
    expect(queued("https://sqs/send")).toHaveLength(0);
    expect(queued<DeliveryJob>("https://sqs/ingest")[0]?.sentCopy?.delivery.status).toBe("delivered");
  });

  it("sends from an alias of the mailbox, but not from someone else's address", async () => {
    expect(
      (await send({ from: "hello@example.com", to: ["x@ext.test"], subject: "", text: "" })).status,
    ).toBe(202);
    expect(rawMime()).toMatch(/^From: Alice <hello@example\.com>$/m);
    const res = await send({ from: "bob@example.com", to: ["x@ext.test"], subject: "", text: "" });
    expect(res.status).toBe(400);
  });

  it("refuses unknown local addresses and suppressed external ones", async () => {
    const unknown = await send({ to: ["nobody@example.com"], subject: "", text: "" });
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toEqual({ error: "no mailbox exists for nobody@example.com" });
    const suppressed = await send({ to: ["gone@ext.test"], subject: "", text: "" });
    expect(suppressed.status).toBe(422);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("refuses to send from or to a full mailbox", async () => {
    const bobBox = { ...directoryKeys.mailbox(MBXB), mailboxId: MBXB, usedBytes: 2048, quotaBytes: 1024 };
    directory.push(bobBox);
    try {
      const res = await send({ to: ["bob@example.com", "carol@ext.test"], subject: "", text: "" });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "not sent: the mailbox of bob@example.com is full" });
    } finally {
      directory.pop();
    }

    ddbMock
      .on(GetCommand, { TableName: "dir-table", Key: directoryKeys.mailbox(MBX) })
      .resolves({ Item: { ...mailbox, usedBytes: 1024, quotaBytes: 1024 } });
    const own = await send({ to: ["carol@ext.test"], subject: "", text: "" });
    expect(own.status).toBe(422);
    expect(((await own.json()) as { error: string }).error).toMatch(/your mailbox is full/);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("threads replies to the original", async () => {
    await send({ to: ["bob@example.org"], subject: "Re: Hello", text: "Thanks", inReplyTo: MSG });
    const mime = rawMime();
    expect(mime).toMatch(/^In-Reply-To: <orig@example\.org>$/m);
    expect(mime).toMatch(/^References: <root@example\.org> <orig@example\.org>$/m);
  });

  it("forwards chosen attachments of the original", async () => {
    await send({
      to: ["x@ext.test"],
      subject: "Fwd: Hello",
      text: "FYI",
      forward: { id: MSG, partIds: ["1"] },
    });
    expect(s3Mock.commandCalls(GetObjectCommand).map((c) => c.args[0].input.Key)).toEqual([
      `mbx/${MBX}/${MSG}/att/1`,
    ]);
    expect(rawMime()).toContain("application/pdf");
    expect(
      (await send({ to: ["x@ext.test"], subject: "", text: "", forward: { id: MSG, partIds: ["9"] } }))
        .status,
    ).toBe(400);
  });

  it("enforces the hourly send limit", async () => {
    ddbMock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "no", $metadata: {} }));
    const res = await send({ to: ["x@ext.test"], subject: "", text: "" });
    expect(res.status).toBe(429);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it("validates the request", async () => {
    const cases = [
      { to: [], subject: "", text: "" },
      { to: ["not an address"], subject: "", text: "" },
      { to: Array.from({ length: 51 }, (_, i) => `u${i}@ext.test`), subject: "", text: "" },
      { to: ["x@ext.test"], text: "" },
      {
        to: ["x@ext.test"],
        subject: "",
        text: "",
        attachments: [{ uploadId: "nope", filename: "a", contentType: "text/plain" }],
      },
      { to: ["x@ext.test"], subject: "", text: "", inReplyTo: "nope" },
    ];
    for (const body of cases) expect((await send(body)).status).toBe(400);
  });

  it("reports a missing upload", async () => {
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error("gone"), { name: "NoSuchKey" }));
    const res = await send({
      to: ["x@ext.test"],
      subject: "",
      text: "",
      attachments: [{ uploadId: UPLOAD, filename: "a", contentType: "text/plain" }],
    });
    expect(res.status).toBe(400);
  });
});
