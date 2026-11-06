import { CloudWatchClient, DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetAccountCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
  StartMessageMoveTaskCommand,
} from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESSION_COOKIE, type SessionUser, sealSession } from "@sesame/api/session";
import { directoryKeys } from "@sesame/core";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { createAdminApp } from "./app.tsx";
import type { AdminDeps } from "./deps.ts";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const ORIGIN = "https://mail.example.com";
const MBX = "01M5ZJ2GVN042RKXX2HW200C0Q";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const sqs = new SQSClient({ region: "us-east-1" });
const ses = new SESv2Client({ region: "us-east-1" });
const cloudwatch = new CloudWatchClient({ region: "us-east-1" });
const ddbMock = mockClient(doc);
const sqsMock = mockClient(sqs);
const sesMock = mockClient(ses);
const cwMock = mockClient(cloudwatch);

const deps: AdminDeps = {
  config: {
    publicUrl: ORIGIN,
    cognitoDomain: "https://sesame.auth.us-east-1.amazoncognito.com",
    userPoolId: "us-east-1_abc",
    clientId: "client123",
    sessionKey: Buffer.alloc(32, 7),
  },
  name: "sesame",
  adminGroup: "sesame-admins",
  directory: { doc, table: "dir" },
  queues: { sqs, name: "sesame" },
  ses,
  cloudwatch,
  now: () => NOW,
  log: () => {},
};
const app = createAdminApp(async () => deps);

const admin: SessionUser = { sub: "s1", email: "root@example.com", groups: ["sesame-admins"] };
const cookie = (user: SessionUser) => `${SESSION_COOKIE}=${sealSession(deps.config.sessionKey, user, NOW)}`;

const directory: Record<string, unknown>[] = [
  { ...directoryKeys.domain("example.com"), type: "domain", domain: "example.com" },
  {
    ...directoryKeys.mailbox(MBX),
    type: "mailbox",
    mailboxId: MBX,
    primaryAddress: "alice@example.com",
    usedBytes: 2 * 1048576,
    quotaBytes: 10 * 1048576,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
  {
    ...directoryKeys.address("alice@example.com"),
    type: "address",
    address: "alice@example.com",
    mailboxId: MBX,
    kind: "primary",
  },
];

function post(path: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: {
      cookie: cookie(admin),
      origin: ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(form).toString(),
  });
}

beforeEach(() => {
  ddbMock.reset();
  sqsMock.reset();
  sesMock.reset();
  cwMock.reset();
  ddbMock.on(ScanCommand).callsFake((input) => ({
    Items: directory.filter((i) => i.type === input.ExpressionAttributeValues?.[":type"]),
  }));
  ddbMock.on(GetCommand).callsFake((input) => ({
    Item: directory.find((i) => i.pk === input.Key.pk && i.sk === input.Key.sk),
  }));
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({ Attributes: directory[1] });
  ddbMock.on(TransactWriteCommand).resolves({});
  sqsMock.on(GetQueueUrlCommand).callsFake((input) => ({ QueueUrl: `https://sqs/${input.QueueName}` }));
  sqsMock.on(GetQueueAttributesCommand).callsFake((input) => ({
    Attributes: {
      QueueArn: `arn:aws:sqs:us-east-1:1:${String(input.QueueUrl).split("/").pop()}`,
      ApproximateNumberOfMessages: String(input.QueueUrl).endsWith("ingest-dlq") ? "2" : "0",
      ApproximateNumberOfMessagesNotVisible: "0",
    },
  }));
  sqsMock.on(StartMessageMoveTaskCommand).resolves({ TaskHandle: "t" });
  sqsMock.on(SendMessageCommand).resolves({});
  sesMock.on(GetAccountCommand).resolves({
    ProductionAccessEnabled: false,
    EnforcementStatus: "HEALTHY",
    SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 3 },
  });
  cwMock.on(DescribeAlarmsCommand).resolves({
    MetricAlarms: [
      { AlarmName: "sesame-ingest-dead-letters", StateValue: "ALARM", StateReason: "1 message" },
    ],
  });
});

describe("access", () => {
  it("sends signed-out visitors to sign in and back", async () => {
    const res = await app.request("/admin/mailboxes");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/api/auth/login?return=%2Fadmin%2Fmailboxes");
  });

  it("turns away users outside the admin group", async () => {
    const res = await app.request("/admin", {
      headers: { cookie: cookie({ sub: "s2", email: "bob@example.com" }) },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("sesame-admins");
  });

  it("rejects form posts from other origins", async () => {
    const res = await post("/admin/domains", { domain: "evil.test" }, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("sends a strict CSP that allows no scripts", async () => {
    const res = await app.request("/admin", { headers: { cookie: cookie(admin) } });
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("pages", () => {
  it("shows SES, queues and alarms on the overview", async () => {
    const res = await app.request("/admin", { headers: { cookie: cookie(admin) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sandbox");
    expect(html).toContain("3 of 200 messages");
    expect(html).toContain("sesame-ingest-dead-letters");
    expect(html).toContain('action="/admin/queues/ingest/redrive"');
  });

  it("lists mailboxes with their storage and escapes directory data", async () => {
    directory.push({
      ...directoryKeys.mailbox("01M5ZJ2GVN042RKXX2HW200C0R"),
      type: "mailbox",
      mailboxId: "01M5ZJ2GVN042RKXX2HW200C0R",
      primaryAddress: "bob@example.com",
      displayName: "<script>alert(1)</script>",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    try {
      const html = await (
        await app.request("/admin/mailboxes", { headers: { cookie: cookie(admin) } })
      ).text();
      expect(html).toContain("2.0 MB of 10 MB");
      expect(html).toContain(`href="/admin/mailboxes/${MBX}"`);
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    } finally {
      directory.pop();
    }
  });
});

describe("changes", () => {
  it("sets a quota, records who did it and redirects with a message", async () => {
    const res = await post(`/admin/mailboxes/${MBX}/quota`, { quota: "50" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/admin/mailboxes/${MBX}?notice=The%20quota%20is%20now%2050%20MB.`,
    );
    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues).toEqual({
      ":q": 50 * 1048576,
    });
    const audit = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(audit).toMatchObject({
      pk: "AUDIT",
      actor: "root@example.com",
      action: "set quota",
      detail: "alice@example.com: 50 MB",
    });
  });

  it("reports bad input on the page instead of failing", async () => {
    const res = await post("/admin/mailboxes", { address: "not an address" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/admin\/mailboxes\?error=/);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("redrives a pipeline's dead-letter queue", async () => {
    const res = await post("/admin/queues/ingest/redrive", {});
    expect(res.status).toBe(303);
    expect(sqsMock.commandCalls(StartMessageMoveTaskCommand)[0]?.args[0].input).toEqual({
      SourceArn: "arn:aws:sqs:us-east-1:1:sesame-ingest-dlq",
    });
  });
});

describe("deleting a mailbox", () => {
  it("explains what will be deleted before asking", async () => {
    const html = await (
      await app.request(`/admin/mailboxes/${MBX}/delete`, { headers: { cookie: cookie(admin) } })
    ).text();
    expect(html).toContain("This can&#39;t be undone.");
    expect(html).toContain("alice@example.com");
    expect(html).toContain(`action="/admin/mailboxes/${MBX}/delete"`);
  });

  it("needs the address typed exactly", async () => {
    const res = await post(`/admin/mailboxes/${MBX}/delete`, { confirm: "alice@example.org" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(new RegExp(`^/admin/mailboxes/${MBX}/delete\\?error=`));
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("removes it from the directory, starts the purge and records who did it", async () => {
    const res = await post(`/admin/mailboxes/${MBX}/delete`, { confirm: "Alice@Example.com" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("Deleted%20alice%40example.com");
    const tx = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(tx.at(-1)?.Put?.Item).toMatchObject({ pk: `PURGE#${MBX}`, requestedBy: "root@example.com" });
    expect(sqsMock.commandCalls(SendMessageCommand)[0]?.args[0].input).toEqual({
      QueueUrl: "https://sqs/sesame-purge",
      MessageBody: JSON.stringify({ mailboxId: MBX }),
    });
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({
      action: "deleted mailbox",
      actor: "root@example.com",
    });
  });

  it("still reports the deletion when the purge can't be queued", async () => {
    sqsMock.on(SendMessageCommand).rejects(new Error("throttled"));
    const res = await post(`/admin/mailboxes/${MBX}/delete`, { confirm: "alice@example.com" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("Restart%20purge");
  });
});
