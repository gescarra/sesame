// Shared fixtures for API tests: mocked AWS clients, a fixed key and a session cookie factory.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type MessageItem, mailKeys, messageObjectPrefix } from "@sesame/core";
import { mockClient } from "aws-sdk-client-mock";
import { createApp } from "./app.ts";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "./auth.ts";
import type { Deps, IdClaims, SessionUser } from "./deps.ts";
import { seal } from "./seal.ts";

export const NOW = Date.parse("2026-10-27T12:00:00.000Z");
export const MBX = "01M5ZJ2GVN042RKXX2HW200C0Q";
export const MSG = "01M5ZJ32HDGDRJ5084ESAB24RW";
export const alice: SessionUser = { sub: "sub-alice", email: "alice@example.com", name: "Alice" };

const s3 = new S3Client({ region: "us-east-1" });
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
export const s3Mock = mockClient(s3);
export const ddbMock = mockClient(doc);
const sqs = new SQSClient({ region: "us-east-1" });
export const sqsMock = mockClient(sqs);

export interface TestDeps extends Deps {
  logs: string[];
  presigned: { key: string | undefined; disposition: string | undefined; type: string | undefined }[];
}

export function testDeps(overrides: Partial<Deps> = {}): TestDeps {
  const logs: string[] = [];
  const presigned: TestDeps["presigned"] = [];
  return {
    config: {
      mailTable: "mail-table",
      mailBucket: "mail-bucket",
      directoryTable: "dir-table",
      ingestQueueUrl: "https://sqs/ingest",
      sendQueueUrl: "https://sqs/send",
      sendRateLimit: 200,
      publicUrl: "https://mail.example.com",
      cognitoDomain: "https://sesame.auth.us-east-1.amazoncognito.com",
      userPoolId: "us-east-1_abc",
      clientId: "client123",
      sessionKey: Buffer.alloc(32, 7),
    },
    doc,
    s3,
    presign: async (command, expiresIn) => {
      const i = command.input;
      presigned.push({ key: i.Key, disposition: i.ResponseContentDisposition, type: i.ResponseContentType });
      return `https://mail-bucket.s3.amazonaws.com/${i.Key}?X-Amz-Expires=${expiresIn}`;
    },
    presignPost: async (options) => ({
      url: "https://mail-bucket.s3.amazonaws.com/",
      fields: { key: options.Key, "Content-Type": String(options.Fields?.["Content-Type"]) },
    }),
    sqs,
    verifyIdToken: async () => ({ sub: "x" }) as IdClaims,
    fetch: async () => new Response("{}", { status: 500 }),
    now: () => NOW,
    log: (level, msg) => logs.push(`${level}: ${msg}`),
    logs,
    presigned,
    ...overrides,
  };
}

export function testApp(deps: Deps) {
  return createApp(async () => deps);
}

export function sessionCookie(deps: Deps, user: SessionUser = alice): string {
  return `${SESSION_COOKIE}=${seal(deps.config.sessionKey, "session", user, SESSION_TTL_SECONDS, NOW)}`;
}

export function message(overrides: Partial<MessageItem> = {}): MessageItem {
  const ulid = overrides.messageUlid ?? MSG;
  const folder = overrides.folder ?? "inbox";
  return {
    ...mailKeys.message(MBX, ulid),
    ...mailKeys.folderView(MBX, folder, ulid),
    ...mailKeys.threadView(MBX, ulid, ulid),
    type: "message",
    mailboxId: MBX,
    messageUlid: ulid,
    folder,
    threadId: ulid,
    from: { name: "Bob", address: "bob@example.org" },
    to: [{ address: "alice@example.com" }],
    cc: [],
    subject: "Hello",
    snippet: "Hi Alice",
    date: "2026-10-27T11:00:00.000Z",
    receivedAt: "2026-10-27T11:00:01.000Z",
    size: 1234,
    read: false,
    flagged: false,
    hasAttachments: true,
    attachments: [
      {
        partId: "0",
        filename: "logo.png",
        contentType: "image/png",
        size: 10,
        inline: true,
        contentId: "logo",
      },
      {
        partId: "1",
        filename: 'résumé "final".pdf',
        contentType: "application/pdf",
        size: 20,
        inline: false,
      },
      { partId: "2", filename: "pic.svg", contentType: "image/svg+xml", size: 30, inline: false },
    ],
    messageIdHeader: "<m1@example.org>",
    objectPrefix: messageObjectPrefix(MBX, ulid),
    ...overrides,
  };
}
