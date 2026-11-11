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
}

export type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

export interface Deps {
  config: EasConfig;
  doc: DynamoDBDocumentClient;
  s3: S3Client;
  sqs: SQSClient;
  now: () => number;
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
    log,
  };
}
