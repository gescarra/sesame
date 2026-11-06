import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mailKeys } from "@sesame/core";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type Deps,
  FINAL_PASS_DELAY_SECONDS,
  InvalidPurgeJobError,
  parsePurgeJob,
  purgeMailbox,
} from "./purge.ts";

const MBX = "01M5ZJ2GVN042RKXX2HW200C0Q";
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const s3 = new S3Client({ region: "us-east-1" });
const sqs = new SQSClient({ region: "us-east-1" });
const ddbMock = mockClient(doc);
const s3Mock = mockClient(s3);
const sqsMock = mockClient(sqs);

const deps: Deps = {
  doc,
  s3,
  sqs,
  mailTable: "mail",
  mailBucket: "bucket",
  directoryTable: "dir",
  queueUrl: "https://sqs/sesame-purge",
  log: () => {},
};
const plenty = () => 300_000;

function deletedKeys() {
  return ddbMock
    .commandCalls(BatchWriteCommand)
    .flatMap((c) => c.args[0].input.RequestItems?.mail ?? [])
    .map((r) => r.DeleteRequest?.Key);
}

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  sqsMock.reset();
  ddbMock.on(GetCommand).resolves({});
  ddbMock.on(QueryCommand).resolves({
    Items: [
      { pk: `MBX#${MBX}`, sk: "FOLDER#inbox" },
      { pk: `MBX#${MBX}`, sk: "MSG#M1", messageUlid: "M1", tokens: ["report", "bob"] },
    ],
  });
  ddbMock.on(BatchWriteCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
  s3Mock.on(ListObjectsV2Command).resolves({
    Contents: [{ Key: `mbx/${MBX}/M1/message.eml` }, { Key: `mbx/${MBX}/M1/body.json` }],
  });
  s3Mock.on(DeleteObjectsCommand).resolves({});
  sqsMock.on(SendMessageCommand).resolves({});
});

describe("parsePurgeJob", () => {
  it("accepts a mailbox ID and rejects anything else", () => {
    expect(parsePurgeJob(JSON.stringify({ mailboxId: MBX, final: true }))).toEqual({
      mailboxId: MBX,
      final: true,
    });
    expect(() => parsePurgeJob('{"mailboxId":"../x"}')).toThrow(InvalidPurgeJobError);
  });
});

describe("purgeMailbox", () => {
  it("deletes the partition, each message's tokens and its objects, then schedules a final pass", async () => {
    expect(await purgeMailbox(deps, { mailboxId: MBX }, plenty)).toBe("final-pass-scheduled");
    expect(deletedKeys()).toEqual([
      { pk: `MBX#${MBX}`, sk: "FOLDER#inbox" },
      mailKeys.searchToken(MBX, "report", "M1"),
      mailKeys.searchToken(MBX, "bob", "M1"),
      { pk: `MBX#${MBX}`, sk: "MSG#M1" },
    ]);
    expect(s3Mock.commandCalls(ListObjectsV2Command)[0]?.args[0].input.Prefix).toBe(`mbx/${MBX}/`);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)[0]?.args[0].input.Delete?.Objects).toHaveLength(2);
    expect(sqsMock.commandCalls(SendMessageCommand)[0]?.args[0].input).toMatchObject({
      MessageBody: JSON.stringify({ mailboxId: MBX, final: true }),
      DelaySeconds: FINAL_PASS_DELAY_SECONDS,
    });
    // The purge marker stays until the final pass.
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it("removes the purge marker after the final pass", async () => {
    expect(await purgeMailbox(deps, { mailboxId: MBX, final: true }, plenty)).toBe("done");
    expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input).toEqual({
      TableName: "dir",
      Key: { pk: `PURGE#${MBX}`, sk: "META" },
    });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("refuses to touch a mailbox that still exists", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { pk: `MBX#${MBX}` } });
    expect(await purgeMailbox(deps, { mailboxId: MBX }, plenty)).toBe("refused");
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });

  it("hands over to a new invocation when time runs low", async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [{ pk: `MBX#${MBX}`, sk: "FOLDER#inbox" }], LastEvaluatedKey: { pk: "x" } });
    expect(await purgeMailbox(deps, { mailboxId: MBX }, () => 30_000)).toBe("continued");
    expect(sqsMock.commandCalls(SendMessageCommand)[0]?.args[0].input).toEqual({
      QueueUrl: "https://sqs/sesame-purge",
      MessageBody: JSON.stringify({ mailboxId: MBX }),
    });
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
  });

  it("fails, to be retried, when S3 can't delete an object", async () => {
    s3Mock
      .on(DeleteObjectsCommand)
      .resolves({ Errors: [{ Key: `mbx/${MBX}/M1/body.json`, Code: "InternalError" }] });
    await expect(purgeMailbox(deps, { mailboxId: MBX }, plenty)).rejects.toThrow("could not delete 1 object");
  });
});
