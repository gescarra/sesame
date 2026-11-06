import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { type Deps, parseSendJob, sendJob } from "./send.ts";

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
    ses: new SESv2Client({}),
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    mailTable: env("MAIL_TABLE"),
    directoryTable: env("DIRECTORY_TABLE"),
    configurationSet: env("SES_CONFIGURATION_SET"),
    now: Date.now,
    log,
  };
  return deps;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const d = getDeps();
  const results = await Promise.allSettled(
    event.Records.map((record) => sendJob(d, parseSendJob(record.body))),
  );
  const batchItemFailures = results.flatMap((r, i) => {
    if (r.status === "fulfilled") return [];
    const record = event.Records[i];
    log("error", "send failed; will retry", { messageId: record?.messageId, error: String(r.reason) });
    return record ? [{ itemIdentifier: record.messageId }] : [];
  });
  return { batchItemFailures };
}
