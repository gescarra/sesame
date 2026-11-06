import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { type Deps, deliverJob } from "./deliver.ts";
import { parseJob } from "./job.ts";

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
    s3: new S3Client({}),
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    mailBucket: env("MAIL_BUCKET"),
    mailTable: env("MAIL_TABLE"),
    directoryTable: env("DIRECTORY_TABLE"),
    indexBody: process.env.SEARCH_INDEX_BODY !== "false",
    log,
  };
  return deps;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const d = getDeps();
  const results = await Promise.allSettled(
    // Failures, including malformed jobs, are retried and then land in the DLQ for inspection.
    event.Records.map(async (record) => {
      const job = parseJob(record.body);
      if (job) await deliverJob(d, job);
    }),
  );

  const batchItemFailures = results.flatMap((r, i) => {
    if (r.status === "fulfilled") return [];
    const record = event.Records[i];
    log("error", "delivery failed", { messageId: record?.messageId, error: String(r.reason) });
    return record ? [{ itemIdentifier: record.messageId }] : [];
  });
  return { batchItemFailures };
}
