import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Context, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { type Deps, parsePurgeJob, purgeMailbox } from "./purge.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

const log: Deps["log"] = (level, msg, fields) => {
  console[level](JSON.stringify({ level, msg, ...fields }));
};

let deps: Deps | undefined;
function getDeps(): Deps {
  deps ??= {
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    s3: new S3Client({}),
    sqs: new SQSClient({}),
    mailTable: env("MAIL_TABLE"),
    mailBucket: env("MAIL_BUCKET"),
    directoryTable: env("DIRECTORY_TABLE"),
    queueUrl: env("PURGE_QUEUE_URL"),
    log,
  };
  return deps;
}

// The event source mapping delivers one job at a time: a purge can use a whole invocation.
export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  const d = getDeps();
  const failures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    try {
      await purgeMailbox(d, parsePurgeJob(record.body), () => context.getRemainingTimeInMillis());
    } catch (err) {
      log("error", "purge failed", { messageId: record.messageId, error: String(err) });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
