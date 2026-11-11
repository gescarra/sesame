// Configuration and outside-world dependencies, injected so tests can replace them.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface EasConfig {
  directoryTable: string;
  mailTable: string;
  mailBucket: string;
}

export type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

export interface Deps {
  config: EasConfig;
  doc: DynamoDBDocumentClient;
  s3: S3Client;
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
  };
}

export async function createDeps(): Promise<Deps> {
  return {
    config: loadConfig(),
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    s3: new S3Client({}),
    now: Date.now,
    log,
  };
}
