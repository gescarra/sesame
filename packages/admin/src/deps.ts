// Everything the admin console needs from the outside world, injected so tests can replace it.
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { loadSharedConfig, type SharedConfig } from "@sesame/api/config";
import type { SessionUser } from "@sesame/api/session";
import type { Ctx, QueueCtx } from "@sesame/ops";

export type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

export interface AdminDeps {
  config: SharedConfig;
  /** The deployment's name prefix, which names its queues and alarms. */
  name: string;
  /** Cognito group whose members may use the console. */
  adminGroup: string;
  directory: Ctx;
  queues: QueueCtx;
  ses: SESv2Client;
  cloudwatch: CloudWatchClient;
  now: () => number;
  log: Log;
}

export type AdminEnv = { Variables: { deps: AdminDeps; user: SessionUser } };

export const log: Log = (level, msg, fields) => {
  console[level](JSON.stringify({ level, msg, ...fields }));
};

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

export async function createDeps(): Promise<AdminDeps> {
  const sqs = new SQSClient({});
  const name = env("SESAME_NAME");
  return {
    config: await loadSharedConfig(),
    name,
    adminGroup: env("ADMIN_GROUP"),
    directory: {
      doc: DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      }),
      table: env("DIRECTORY_TABLE"),
    },
    queues: { sqs, name },
    ses: new SESv2Client({}),
    cloudwatch: new CloudWatchClient({}),
    now: Date.now,
    log,
  };
}
