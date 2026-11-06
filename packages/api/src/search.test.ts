import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { buildIndex, directoryKeys, type MessageItem, mailKeys } from "@sesame/core";
import { beforeEach, describe, expect, it } from "vitest";
import { ddbMock, MBX, message, s3Mock, sessionCookie, type TestDeps, testApp, testDeps } from "./testing.ts";

const member = { ...directoryKeys.member(MBX, "alice@example.com"), mailboxId: MBX, role: "owner" };

// IDs sort by time: M1 oldest, M4 newest.
const M1 = "01M5ZJ32HDGDRJ5084ESAB0001";
const M2 = "01M5ZJ32HDGDRJ5084ESAB0002";
const M3 = "01M5ZJ32HDGDRJ5084ESAB0003";
const M4 = "01M5ZJ32HDGDRJ5084ESAB0004";

const messages: MessageItem[] = [
  message({
    messageUlid: M1,
    subject: "Quarterly report",
    from: { name: "Bob", address: "bob@example.org" },
  }),
  message({
    messageUlid: M2,
    subject: "Lunch plans",
    from: { address: "carol@example.net" },
    hasAttachments: false,
  }),
  message({ messageUlid: M3, subject: "Old report", folder: "trash" }),
  message({ messageUlid: M4, subject: "Report your prize", folder: "junk", hasAttachments: false }),
];

/** The index items ingest would have written for these messages. */
const index = messages.flatMap((m) =>
  [
    ...buildIndex({
      subject: m.subject,
      from: m.from,
      to: m.to,
      cc: m.cc,
      attachmentNames: m.attachments.filter((a) => !a.inline).map((a) => a.filename),
    }),
  ].map(([token, f]) => ({ ...mailKeys.searchToken(MBX, token, m.messageUlid), ulid: m.messageUlid, f })),
);

let deps: TestDeps;
let app: ReturnType<typeof testApp>;

async function search(q: string, extra = "") {
  const res = await app.request(`/api/mailboxes/${MBX}/search?q=${encodeURIComponent(q)}${extra}`, {
    headers: { cookie: sessionCookie(deps) },
  });
  const body = (await res.json()) as { items?: { id: string }[]; cursor?: string; error?: string };
  return { status: res.status, ids: body.items?.map((m) => m.id), cursor: body.cursor, body };
}

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  deps = testDeps();
  app = testApp(deps);
  ddbMock
    .on(GetCommand)
    .callsFake((input) =>
      input.TableName === "dir-table"
        ? { Item: input.Key.sk === member.sk ? member : undefined }
        : { Item: undefined },
    );
  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues as Record<string, string>;
    const items = index.filter(
      (i) =>
        i.pk === values[":pk"] &&
        i.sk.startsWith(values[":prefix"] ?? "") &&
        (!values[":field"] || i.f.has(values[":field"] as never)),
    );
    return { Items: items.map((i) => ({ ulid: i.ulid })), ScannedCount: items.length };
  });
  ddbMock.on(BatchGetCommand).callsFake((input) => {
    const keys = (input.RequestItems["mail-table"]?.Keys ?? []) as { sk: string }[];
    return { Responses: { "mail-table": messages.filter((m) => keys.some((k) => k.sk === m.sk)) } };
  });
});

describe("GET /api/mailboxes/:mbx/search", () => {
  it("finds words by prefix, newest first, leaving out junk and trash", async () => {
    expect((await search("rep")).ids).toEqual([M1]);
    expect((await search("rep in:anywhere")).ids).toEqual([M4, M3, M1]);
    expect((await search("report in:trash")).ids).toEqual([M3]);
  });

  it("requires every word to match", async () => {
    expect((await search("quarterly bob")).ids).toEqual([M1]);
    expect((await search("lunch bob")).ids).toEqual([]);
  });

  it("restricts words to a field with operators", async () => {
    expect((await search("from:carol")).ids).toEqual([M2]);
    expect((await search("subject:carol")).ids).toEqual([]);
    expect((await search("from:bob@example.org")).ids).toEqual([M1]);
    // Every fixture message carries the attachment "résumé \"final\".pdf".
    expect((await search("file:resume")).ids).toEqual([M2, M1]);
  });

  it("filters on attachments, folders and read state", async () => {
    expect((await search("report has:attachment in:anywhere")).ids).toEqual([M3, M1]);
    expect((await search("plans is:unread")).ids).toEqual([M2]);
  });

  it("pages through results with a cursor", async () => {
    const first = await search("report in:anywhere", "&limit=2");
    expect(first.ids).toEqual([M4, M3]);
    expect(first.cursor).toBe(M3);
    const second = await search("report in:anywhere", `&limit=2&cursor=${first.cursor}`);
    expect(second.ids).toEqual([M1]);
    expect(second.cursor).toBeUndefined();
  });

  it("rejects searches without words", async () => {
    expect((await search("the")).status).toBe(400);
    expect((await search("has:attachment")).status).toBe(400);
    expect((await search("x", "&cursor=nope")).status).toBe(400);
  });

  it("deletes a message's tokens when it's purged from trash", async () => {
    const trashed = message({ folder: "trash", tokens: ["old", "report"] });
    ddbMock
      .on(GetCommand)
      .callsFake((input) => (input.TableName === "dir-table" ? { Item: member } : { Item: trashed }));
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
    await app.request(`/api/mailboxes/${MBX}/messages/${trashed.messageUlid}`, {
      method: "DELETE",
      headers: { cookie: sessionCookie(deps), "x-requested-with": "sesame" },
    });
    const deletes = ddbMock.commandCalls(BatchWriteCommand)[0]?.args[0].input.RequestItems?.["mail-table"];
    expect(deletes?.map((r) => r.DeleteRequest?.Key)).toEqual([
      mailKeys.searchToken(MBX, "old", trashed.messageUlid),
      mailKeys.searchToken(MBX, "report", trashed.messageUlid),
    ]);
  });
});
