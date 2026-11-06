// Status, inspection and redrive of the three pipelines' queues and dead-letter queues.
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
  StartMessageMoveTaskCommand,
} from "@aws-sdk/client-sqs";
import type { PurgeJob } from "@sesame/core";
import { UserError } from "./directory.ts";

/** Pipeline name → queue name suffix, as the Terraform modules name them. */
export const PIPELINES = { ingest: "ingest", send: "send", events: "ses-events", purge: "purge" } as const;
export type Pipeline = keyof typeof PIPELINES;

export interface QueueCtx {
  sqs: SQSClient;
  /** The deployment's name prefix (Terraform `name`). */
  name: string;
}

export function isPipeline(value: string | undefined): value is Pipeline {
  return value !== undefined && Object.hasOwn(PIPELINES, value);
}

interface QueueInfo {
  url: string;
  arn: string;
  visible: number;
  inFlight: number;
}

async function queueInfo(ctx: QueueCtx, queueName: string): Promise<QueueInfo> {
  let url: string | undefined;
  try {
    url = (await ctx.sqs.send(new GetQueueUrlCommand({ QueueName: queueName }))).QueueUrl;
  } catch (err) {
    if ((err as { name?: string }).name === "QueueDoesNotExist") {
      throw new UserError(`queue ${queueName} not found; set SESAME_NAME if you deployed with another name`);
    }
    throw err;
  }
  if (!url) throw new UserError(`queue ${queueName} not found`);
  const { Attributes: a = {} } = await ctx.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ["QueueArn", "ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return {
    url,
    arn: a.QueueArn ?? "",
    visible: Number(a.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(a.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

const queueName = (ctx: QueueCtx, p: Pipeline) => `${ctx.name}-${PIPELINES[p]}`;
const dlqName = (ctx: QueueCtx, p: Pipeline) => `${queueName(ctx, p)}-dlq`;

export interface PipelineStatus {
  pipeline: Pipeline;
  queued: number;
  inFlight: number;
  dead: number;
}

export async function queueStatus(ctx: QueueCtx): Promise<PipelineStatus[]> {
  return Promise.all(
    (Object.keys(PIPELINES) as Pipeline[]).map(async (pipeline) => {
      const [queue, dlq] = await Promise.all([
        queueInfo(ctx, queueName(ctx, pipeline)),
        queueInfo(ctx, dlqName(ctx, pipeline)),
      ]);
      return { pipeline, queued: queue.visible, inFlight: queue.inFlight, dead: dlq.visible };
    }),
  );
}

export interface DeadMessage {
  messageId: string;
  sentAt: string;
  receiveCount: number;
  summary: string;
  body: string;
}

/**
 * Reads up to 10 messages from a DLQ without taking them: they stay visible, so a redrive
 * right after still moves them.
 */
export async function peekDead(ctx: QueueCtx, p: Pipeline, max = 10): Promise<DeadMessage[]> {
  const { url } = await queueInfo(ctx, dlqName(ctx, p));
  const res = await ctx.sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: Math.min(Math.max(max, 1), 10),
      VisibilityTimeout: 0,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ["SentTimestamp", "ApproximateReceiveCount"],
    }),
  );
  // With no visibility timeout, one receive can return the same message several times.
  const unique = [...new Map((res.Messages ?? []).map((m) => [m.MessageId, m])).values()];
  return unique.map((m) => ({
    messageId: m.MessageId ?? "",
    sentAt: new Date(Number(m.Attributes?.SentTimestamp ?? 0)).toISOString(),
    receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 0),
    summary: summarize(m.Body ?? ""),
    body: m.Body ?? "",
  }));
}

/** Moves every message in a pipeline's DLQ back to its queue. Returns how many were waiting. */
export async function redrive(
  ctx: QueueCtx,
  p: Pipeline,
): Promise<{ moved: number; from: string; to: string }> {
  const dlq = await queueInfo(ctx, dlqName(ctx, p));
  if (dlq.visible === 0) return { moved: 0, from: dlqName(ctx, p), to: queueName(ctx, p) };
  // Without a destination, SQS returns each message to the queue it dead-lettered from.
  await ctx.sqs.send(new StartMessageMoveTaskCommand({ SourceArn: dlq.arn }));
  return { moved: dlq.visible, from: dlqName(ctx, p), to: queueName(ctx, p) };
}

/** Asks the purge Lambda to delete a deleted mailbox's mail. Safe to repeat. */
export async function enqueuePurge(ctx: QueueCtx, mailboxId: string): Promise<void> {
  const { url } = await queueInfo(ctx, queueName(ctx, "purge"));
  const job: PurgeJob = { mailboxId };
  await ctx.sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: JSON.stringify(job) }));
}

/** One line describing a queued job, whichever pipeline it belongs to. */
// biome-ignore lint/suspicious/noExplicitAny: summarize() probes several job shapes.
type Loose = Record<string, any>;

export function summarize(body: string): string {
  let msg: Loose;
  try {
    msg = JSON.parse(body) as Loose;
    // SNS envelopes wrap SES notifications and events.
    if (msg.Type === "Notification" && typeof msg.Message === "string")
      msg = JSON.parse(msg.Message) as Loose;
  } catch {
    return body.slice(0, 120);
  }
  const list = (a: unknown) => (Array.isArray(a) ? a.join(", ") : "");
  if (msg.notificationType === "Received") {
    const subject = msg.mail?.commonHeaders?.subject ?? "";
    return `inbound from ${msg.mail?.source} to ${list(msg.receipt?.recipients)}: "${subject}"`;
  }
  if (msg.eventType) {
    return `SES ${msg.eventType} event for ${msg.mail?.messageId} to ${list(msg.mail?.destination)}`;
  }
  if (Array.isArray(msg.destinations)) {
    return `send job ${msg.id} from ${msg.from} to ${list(msg.destinations)}`;
  }
  if (typeof msg.mailboxId === "string" && !msg.recipients && !msg.destinations) {
    return `${msg.final ? "final " : ""}purge of deleted mailbox ${msg.mailboxId}`;
  }
  if (Array.isArray(msg.recipients)) {
    const sent = msg.sentCopy ? `, Sent copy for ${msg.sentCopy.mailboxId}` : "";
    return `internal delivery ${msg.id} to ${list(msg.recipients) || "(no local recipients)"}${sent}`;
  }
  return body.slice(0, 120);
}
