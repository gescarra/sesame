// Deletes everything a deleted mailbox left behind: the items in its mail-table partition (messages,
// folder counters, Message-ID maps), each message's search tokens, and its objects under mbx/<id>/.
//
// The directory entries are already gone when this runs (see deleteMailbox in @sesame/ops), so no new
// mail can arrive. A delivery that was already in flight can still write objects, so a final pass
// runs again after FINAL_PASS_DELAY_SECONDS and only then removes the purge marker.
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { DeleteCommand, type DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { deleteKeys, directoryKeys, mailboxObjectPrefix, mailKeys, type PurgeJob } from "@sesame/core";

export const FINAL_PASS_DELAY_SECONDS = 900;
/** Stop and hand over to a fresh invocation when less than this much time is left. */
const RESERVE_MS = 60_000;

export interface Deps {
  doc: DynamoDBDocumentClient;
  s3: S3Client;
  sqs: SQSClient;
  mailTable: string;
  mailBucket: string;
  directoryTable: string;
  /** This Lambda's own queue, for continuations and the final pass. */
  queueUrl: string;
  log: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

export class InvalidPurgeJobError extends Error {}

export function parsePurgeJob(body: string): PurgeJob {
  let job: Partial<PurgeJob>;
  try {
    job = JSON.parse(body);
  } catch {
    throw new InvalidPurgeJobError("body is not JSON");
  }
  if (typeof job.mailboxId !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(job.mailboxId)) {
    throw new InvalidPurgeJobError("purge job needs a mailbox ID");
  }
  return job.final ? { mailboxId: job.mailboxId, final: true } : { mailboxId: job.mailboxId };
}

export type PurgeOutcome = "refused" | "continued" | "final-pass-scheduled" | "done";

export async function purgeMailbox(
  deps: Deps,
  job: PurgeJob,
  timeLeftMs: () => number,
): Promise<PurgeOutcome> {
  const { mailboxId } = job;
  const fields = { mailboxId, final: job.final === true };

  // Never purge a mailbox that exists: only deleteMailbox removes the directory item.
  const live = await deps.doc.send(
    new GetCommand({
      TableName: deps.directoryTable,
      Key: directoryKeys.mailbox(mailboxId),
      ProjectionExpression: "pk",
    }),
  );
  if (live.Item) {
    deps.log("error", "refusing to purge a mailbox that still exists", fields);
    return "refused";
  }

  const outOfTime = () => timeLeftMs() < RESERVE_MS;
  const counts = { items: 0, tokens: 0, objects: 0 };

  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await deps.doc.send(
      new QueryCommand({
        TableName: deps.mailTable,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `MBX#${mailboxId}` },
        ProjectionExpression: "pk, sk, messageUlid, tokens",
        Limit: 200,
        ExclusiveStartKey,
      }),
    );
    const keys: Record<string, unknown>[] = [];
    for (const item of res.Items ?? []) {
      // A message's tokens live in other partitions; its item records which ones.
      if (typeof item.messageUlid === "string" && Array.isArray(item.tokens)) {
        for (const token of item.tokens as string[])
          keys.push(mailKeys.searchToken(mailboxId, token, item.messageUlid));
        counts.tokens += item.tokens.length;
      }
      keys.push({ pk: item.pk, sk: item.sk });
      counts.items++;
    }
    await deleteKeys(deps.doc, deps.mailTable, keys);
    ExclusiveStartKey = res.LastEvaluatedKey;
    if (ExclusiveStartKey && outOfTime()) return continueLater(deps, job, counts);
  } while (ExclusiveStartKey);

  const Prefix = mailboxObjectPrefix(mailboxId);
  let ContinuationToken: string | undefined;
  do {
    const page = await deps.s3.send(
      new ListObjectsV2Command({ Bucket: deps.mailBucket, Prefix, ContinuationToken }),
    );
    const objects = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (objects.length) {
      const res = await deps.s3.send(
        new DeleteObjectsCommand({ Bucket: deps.mailBucket, Delete: { Objects: objects, Quiet: true } }),
      );
      if (res.Errors?.length)
        throw new Error(`could not delete ${res.Errors.length} object(s), e.g. ${res.Errors[0]?.Key}`);
      counts.objects += objects.length;
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (ContinuationToken && outOfTime()) return continueLater(deps, job, counts);
  } while (ContinuationToken);

  if (!job.final) {
    await deps.sqs.send(
      new SendMessageCommand({
        QueueUrl: deps.queueUrl,
        MessageBody: JSON.stringify({ mailboxId, final: true } satisfies PurgeJob),
        DelaySeconds: FINAL_PASS_DELAY_SECONDS,
      }),
    );
    deps.log("info", "mailbox purged; final pass scheduled", { ...fields, ...counts });
    return "final-pass-scheduled";
  }
  await deps.doc.send(
    new DeleteCommand({ TableName: deps.directoryTable, Key: directoryKeys.purge(mailboxId) }),
  );
  deps.log("info", "mailbox purge finished", { ...fields, ...counts });
  return "done";
}

async function continueLater(
  deps: Deps,
  job: PurgeJob,
  counts: Record<string, number>,
): Promise<PurgeOutcome> {
  // Everything deleted so far is gone, so the next invocation simply starts over.
  await deps.sqs.send(new SendMessageCommand({ QueueUrl: deps.queueUrl, MessageBody: JSON.stringify(job) }));
  deps.log("info", "purge continues in a new invocation", { mailboxId: job.mailboxId, ...counts });
  return "continued";
}
