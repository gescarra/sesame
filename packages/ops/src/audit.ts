// A record of changes made through the admin console, kept in the directory table.
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { directoryKeys, newUlid } from "@sesame/core";
import type { Ctx } from "./directory.ts";

const RETENTION_DAYS = 180;

export interface AuditEntry {
  at: string;
  /** Login email of whoever made the change. */
  actor: string;
  action: string;
  detail: string;
}

export async function recordAudit(ctx: Ctx, entry: Omit<AuditEntry, "at">, now = Date.now()): Promise<void> {
  const at = new Date(now).toISOString();
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.table,
      Item: {
        ...directoryKeys.audit(at, newUlid(now)),
        type: "audit",
        at,
        ...entry,
        ttl: Math.floor(now / 1000) + RETENTION_DAYS * 86400,
      },
    }),
  );
}

export async function listAudit(ctx: Ctx, limit = 50): Promise<AuditEntry[]> {
  const res = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.table,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "AUDIT" },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (res.Items ?? []).map((i) => ({
    at: String(i.at),
    actor: String(i.actor),
    action: String(i.action),
    detail: String(i.detail ?? ""),
  }));
}
