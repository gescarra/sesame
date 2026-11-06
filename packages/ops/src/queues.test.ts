import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  StartMessageMoveTaskCommand,
} from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { peekDead, type QueueCtx, queueStatus, redrive, summarize } from "./queues.ts";

const sqs = new SQSClient({ region: "us-east-1" });
const sqsMock = mockClient(sqs);
const ctx: QueueCtx = { sqs, name: "sesame" };
const depth: Record<string, [number, number]> = {};

beforeEach(() => {
  sqsMock.reset();
  for (const k of Object.keys(depth)) delete depth[k];
  sqsMock.on(GetQueueUrlCommand).callsFake((input) => ({ QueueUrl: `https://sqs/${input.QueueName}` }));
  sqsMock.on(GetQueueAttributesCommand).callsFake((input) => {
    const name = String(input.QueueUrl).split("/").pop() ?? "";
    const [visible, inFlight] = depth[name] ?? [0, 0];
    return {
      Attributes: {
        QueueArn: `arn:aws:sqs:us-east-1:1:${name}`,
        ApproximateNumberOfMessages: String(visible),
        ApproximateNumberOfMessagesNotVisible: String(inFlight),
      },
    };
  });
  sqsMock.on(StartMessageMoveTaskCommand).resolves({ TaskHandle: "t" });
});

describe("queues", () => {
  it("reports each pipeline's queue and DLQ", async () => {
    depth["sesame-ingest"] = [2, 1];
    depth["sesame-send-dlq"] = [3, 0];
    expect(await queueStatus(ctx)).toEqual([
      { pipeline: "ingest", queued: 2, inFlight: 1, dead: 0 },
      { pipeline: "send", queued: 0, inFlight: 0, dead: 3 },
      { pipeline: "events", queued: 0, inFlight: 0, dead: 0 },
      { pipeline: "purge", queued: 0, inFlight: 0, dead: 0 },
    ]);
  });

  it("redrives a DLQ back to the queue it came from", async () => {
    depth["sesame-ses-events-dlq"] = [4, 0];
    expect(await redrive(ctx, "events")).toEqual({
      moved: 4,
      from: "sesame-ses-events-dlq",
      to: "sesame-ses-events",
    });
    expect(sqsMock.commandCalls(StartMessageMoveTaskCommand)[0]?.args[0].input).toEqual({
      SourceArn: "arn:aws:sqs:us-east-1:1:sesame-ses-events-dlq",
    });
  });

  it("doesn't start a redrive for an empty DLQ", async () => {
    expect((await redrive(ctx, "ingest")).moved).toBe(0);
    expect(sqsMock.commandCalls(StartMessageMoveTaskCommand)).toHaveLength(0);
  });

  it("peeks without hiding messages, listing each once", async () => {
    const dead = {
      MessageId: "m1",
      Body: JSON.stringify({ id: "J1", from: "a@x.test", destinations: ["b@y.test"] }),
      Attributes: { SentTimestamp: "1761652800000", ApproximateReceiveCount: "6" },
    };
    sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [dead, dead, dead] });
    const peeked = await peekDead(ctx, "send");
    expect(peeked).toHaveLength(1);
    const [m] = peeked;
    expect(m).toMatchObject({
      messageId: "m1",
      sentAt: "2025-10-28T12:00:00.000Z",
      receiveCount: 6,
      summary: "send job J1 from a@x.test to b@y.test",
    });
    expect(sqsMock.commandCalls(ReceiveMessageCommand)[0]?.args[0].input).toMatchObject({
      QueueUrl: "https://sqs/sesame-send-dlq",
      VisibilityTimeout: 0,
    });
  });
});

describe("summarize", () => {
  it("describes each pipeline's jobs", () => {
    const sns = (m: unknown) => JSON.stringify({ Type: "Notification", Message: JSON.stringify(m) });
    expect(
      summarize(
        sns({
          notificationType: "Received",
          mail: { source: "carol@ext.test", commonHeaders: { subject: "Hi" } },
          receipt: { recipients: ["alice@example.com"] },
        }),
      ),
    ).toBe('inbound from carol@ext.test to alice@example.com: "Hi"');
    expect(
      summarize(sns({ eventType: "Bounce", mail: { messageId: "ses-1", destination: ["b@y.test"] } })),
    ).toBe("SES Bounce event for ses-1 to b@y.test");
    expect(
      summarize(
        JSON.stringify({ id: "J2", recipients: ["bob@example.com"], sentCopy: { mailboxId: "MBXA" } }),
      ),
    ).toBe("internal delivery J2 to bob@example.com, Sent copy for MBXA");
    expect(summarize("not json")).toBe("not json");
  });
});
