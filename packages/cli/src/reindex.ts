// Rebuilds the search index for existing messages, e.g. mail that arrived before search existed.
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { type DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildIndex,
  deleteIndex,
  htmlToSearchText,
  type MessageItem,
  mailKeys,
  writeIndex,
} from "@sesame/core";

export interface ReindexCtx {
  doc: DynamoDBDocumentClient;
  s3: S3Client;
  mailTable: string;
  mailBucket: string;
  indexBody: boolean;
}

async function bodyText(ctx: ReindexCtx, m: MessageItem): Promise<string> {
  try {
    const res = await ctx.s3.send(
      new GetObjectCommand({ Bucket: ctx.mailBucket, Key: `${m.objectPrefix}body.json` }),
    );
    const body = JSON.parse((await res.Body?.transformToString("utf8")) ?? "{}") as {
      text?: string;
      html?: string;
    };
    return body.text ?? (body.html ? htmlToSearchText(body.html) : "");
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") return "";
    throw err;
  }
}

/** Reindexes every message in a mailbox; returns how many it processed. */
export async function reindexMailbox(
  ctx: ReindexCtx,
  mailboxId: string,
  progress: (done: number) => void = () => {},
): Promise<number> {
  let done = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.mailTable,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :msg)",
        ExpressionAttributeValues: { ":pk": `MBX#${mailboxId}`, ":msg": "MSG#" },
        ExclusiveStartKey,
      }),
    );
    for (const m of (res.Items ?? []) as MessageItem[]) {
      const index = buildIndex({
        subject: m.subject,
        from: m.from,
        to: m.to,
        cc: m.cc,
        attachmentNames: m.attachments.filter((a) => !a.inline).map((a) => a.filename),
        bodyText: ctx.indexBody ? await bodyText(ctx, m) : undefined,
      });
      const tokens = [...index.keys()];
      const stale = (m.tokens ?? []).filter((t) => !index.has(t));
      if (stale.length) await deleteIndex(ctx.doc, ctx.mailTable, mailboxId, m.messageUlid, stale);
      await writeIndex(ctx.doc, ctx.mailTable, mailboxId, m.messageUlid, index);
      await ctx.doc.send(
        new UpdateCommand({
          TableName: ctx.mailTable,
          Key: mailKeys.message(mailboxId, m.messageUlid),
          UpdateExpression: "SET tokens = :t",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":t": tokens },
        }),
      );
      progress(++done);
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return done;
}
