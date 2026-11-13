// Configuration and outside-world dependencies, injected so tests can replace them.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface EasConfig {
  directoryTable: string;
  mailTable: string;
  mailBucket: string;
  /** Mail a phone sends goes where the web app's does: internal and Sent copies to ingest. */
  ingestQueueUrl: string;
  /** External recipients, for the sender Lambda and SES. */
  sendQueueUrl: string;
  /** Messages one person may send per hour, shared with the web app. */
  sendRateLimit: number;
  /** Whether Ping is offered. Off, phones set to Push fall back to fetching on a schedule. */
  push: boolean;
  /**
   * The longest Ping heartbeat, in seconds. CloudFront gives up on an origin that hasn't
   * answered within its origin read timeout, so a held Ping must answer well before that.
   */
  maxHeartbeat: number;
}

export type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

export interface Deps {
  config: EasConfig;
  doc: DynamoDBDocumentClient;
  s3: S3Client;
  sqs: SQSClient;
  now: () => number;
  /** Waits between Ping's polls; tests replace it to move a fake clock. */
  sleep: (ms: number) => Promise<void>;
  log: Log;
}

export const log: Log = (level, msg, fields) => {
  console[level](JSON.stringify({ level, msg, ...fields }));
};

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

/** Unlike the API, ActiveSync needs no Cognito settings or cookie key, so no SSM parameter. */
export function loadConfig(): EasConfig {
  return {
    directoryTable: env("DIRECTORY_TABLE"),
    mailTable: env("MAIL_TABLE"),
    mailBucket: env("MAIL_BUCKET"),
    ingestQueueUrl: env("INGEST_QUEUE_URL"),
    sendQueueUrl: env("SEND_QUEUE_URL"),
    sendRateLimit: Number(process.env.SEND_RATE_LIMIT ?? 200),
    push: process.env.EAS_PUSH === "true",
    maxHeartbeat: Number(process.env.EAS_MAX_HEARTBEAT ?? 50),
  };
}

export async function createDeps(): Promise<Deps> {
  return {
    config: loadConfig(),
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    s3: new S3Client({}),
    sqs: new SQSClient({}),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
  };
}
