import { Readable } from "node:stream";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  MessageRejected,
  SESv2Client,
  SendEmailCommand,
  TooManyRequestsException,
} from "@aws-sdk/client-sesv2";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { OutboundDelivery, SendJob } from "@sesame/core";
import { sdkStreamMixin } from "@smithy/util-stream";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { type Deps, InvalidSendJobError, parseSendJob, sendJob } from "./send.ts";

const s3 = new S3Client({ region: "us-east-1" });
const ses = new SESv2Client({ region: "us-east-1" });
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const s3Mock = mockClient(s3);
const sesMock = mockClient(ses);
const ddbMock = mockClient(doc);

const deps: Deps = {
  s3,
  ses,
  doc,
  mailTable: "mail",
  directoryTable: "dir",
  configurationSet: "sesame",
  now: () => Date.parse("2026-10-28T12:00:00Z"),
  log: () => {},
};

const job: SendJob = {
  id: "J1",
  bucket: "b",
  key: "raw/outbound/J1.eml",
  from: "alice@example.com",
  destinations: ["x@ext.test", "y@ext.test"],
  mailboxId: "M",
  sentUlid: "S",
};

let sentCopy: { pk: string; delivery: OutboundDelivery } | undefined;
let lock: Record<string, unknown> | undefined;
let mailboxDeleted = false;

/** The delivery state the last UpdateCommand on the Sent copy wrote. */
function lastDelivery(): OutboundDelivery | undefined {
  const updates = ddbMock.commandCalls(UpdateCommand).filter((c) => c.args[0].input.Key?.sk === "MSG#S");
  return updates.at(-1)?.args[0].input.ExpressionAttributeValues?.[":next"] as OutboundDelivery | undefined;
}

beforeEach(() => {
  s3Mock.reset();
  sesMock.reset();
  ddbMock.reset();
  lock = undefined;
  mailboxDeleted = false;
  sentCopy = {
    pk: "MBX#M",
    delivery: {
      status: "sending",
      recipients: {
        "x@ext.test": { status: "sending", at: "t" },
        "y@ext.test": { status: "sending", at: "t" },
      },
      updatedAt: "t0",
    },
  };
  s3Mock
    .on(GetObjectCommand)
    .callsFake(() => ({ Body: sdkStreamMixin(Readable.from([Buffer.from("MIME")])) }));
  ddbMock.on(PutCommand).callsFake((input) => {
    if (input.Item?.pk === "SEND#J1") {
      if (lock) throw new ConditionalCheckFailedException({ message: "exists", $metadata: {} });
      lock = input.Item;
    }
    return {};
  });
  ddbMock.on(GetCommand).callsFake((input) => {
    if (input.TableName === "dir") return { Item: mailboxDeleted ? undefined : { pk: "MBX#M" } };
    if (input.Key.pk === "SEND#J1") return { Item: lock };
    return { Item: sentCopy };
  });
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
  sesMock.on(SendEmailCommand).resolves({ MessageId: "ses-1" });
});

describe("parseSendJob", () => {
  it("accepts complete jobs and rejects the rest", () => {
    expect(parseSendJob(JSON.stringify(job))).toEqual(job);
    expect(() => parseSendJob("{}")).toThrow(InvalidSendJobError);
    expect(() => parseSendJob(JSON.stringify({ ...job, destinations: [] }))).toThrow(InvalidSendJobError);
    expect(() => parseSendJob(JSON.stringify({ ...job, destinations: ["nope"] }))).toThrow(
      InvalidSendJobError,
    );
  });
});

describe("sendJob", () => {
  it("sends the raw message to the external destinations only", async () => {
    expect(await sendJob(deps, job)).toBe("sent");
    const input = sesMock.commandCalls(SendEmailCommand)[0]?.args[0].input;
    expect(input).toMatchObject({
      FromEmailAddress: "alice@example.com",
      Destination: { ToAddresses: ["x@ext.test", "y@ext.test"] },
      ConfigurationSetName: "sesame",
    });
    expect(Buffer.from(input?.Content?.Raw?.Data ?? []).toString()).toBe("MIME");

    const map = ddbMock.commandCalls(PutCommand).find((c) => c.args[0].input.Item?.pk === "SES#ses-1");
    expect(map?.args[0].input.Item).toMatchObject({ mailboxId: "M", sentUlid: "S" });
    expect(lastDelivery()).toMatchObject({ status: "sent", sesMessageId: "ses-1" });
    expect(lastDelivery()?.recipients["x@ext.test"]?.status).toBe("sent");
  });

  it("never sends twice: a redelivery only finishes the bookkeeping", async () => {
    lock = { pk: "SEND#J1", status: "sent", sesMessageId: "ses-1" };
    expect(await sendJob(deps, job)).toBe("already-sent");
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(lastDelivery()?.sesMessageId).toBe("ses-1");
  });

  it("marks recipients failed when a previous attempt died mid-send", async () => {
    lock = { pk: "SEND#J1", status: "sending" };
    expect(await sendJob(deps, job)).toBe("failed");
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(lastDelivery()?.status).toBe("failed");
  });

  it("releases the lock and retries on throttling", async () => {
    sesMock
      .on(SendEmailCommand)
      .rejects(new TooManyRequestsException({ message: "slow down", $metadata: {} }));
    await expect(sendJob(deps, job)).rejects.toThrow("slow down");
    expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input.Key).toEqual({ pk: "SEND#J1", sk: "META" });
  });

  it("fails the message when SES rejects it", async () => {
    sesMock.on(SendEmailCommand).rejects(
      new MessageRejected({
        message: "Email address is not verified.",
        $metadata: { httpStatusCode: 400 },
      }),
    );
    expect(await sendJob(deps, job)).toBe("failed");
    expect(lastDelivery()?.recipients["y@ext.test"]).toMatchObject({
      status: "failed",
      detail: "Email address is not verified.",
    });
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it("still sends mail from a mailbox deleted after queuing it, without recording delivery", async () => {
    sentCopy = undefined;
    mailboxDeleted = true;
    expect(await sendJob(deps, job)).toBe("sent");
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  it("retries later when ingest hasn't filed the Sent copy yet", async () => {
    sentCopy = undefined;
    await expect(sendJob(deps, job)).rejects.toThrow("not found");
    // The lock already holds the SES ID, so the retry won't send again.
    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues).toMatchObject({
      ":id": "ses-1",
    });
  });
});
