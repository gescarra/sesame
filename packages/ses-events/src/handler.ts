import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { type Deps, handleEvent } from "./events.ts";

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
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    mailTable: env("MAIL_TABLE"),
    directoryTable: env("DIRECTORY_TABLE"),
    now: Date.now,
    log,
  };
  return deps;
}

/** SES events arrive through SNS and an SQS queue (raw delivery), so failures retry and then dead-letter. */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const d = getDeps();
  const results = await Promise.allSettled(event.Records.map((record) => handleEvent(d, record.body)));
  const batchItemFailures = results.flatMap((r, i) => {
    if (r.status === "fulfilled") return [];
    const record = event.Records[i];
    log("warn", "event not applied; will retry", { messageId: record?.messageId, error: String(r.reason) });
    return record ? [{ itemIdentifier: record.messageId }] : [];
  });
  return { batchItemFailures };
}
