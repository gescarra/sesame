// Test fixtures: an in-memory stand-in for the DynamoDB document client and a request helper.
// The fake understands the expressions sesame's ActiveSync code writes: SET (including
// if_not_exists), ADD, REMOVE, and attribute_exists / attribute_not_exists conditions.
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  type AppPasswordItem,
  directoryKeys,
  hashAppPassword,
  type MailboxItem,
  type MemberItem,
} from "@sesame/core";
import { mockClient } from "aws-sdk-client-mock";
import { createApp } from "./app.ts";
import type { Deps } from "./deps.ts";
import { WBXML_TYPE } from "./protocol.ts";
import { decode, type Element, encode } from "./wbxml/codec.ts";

export const NOW = Date.parse("2026-11-11T12:00:00.000Z");
export const MBX = "01M5ZJ2GVN042RKXX2HW200C0Q";
export const ALICE = "alice@example.com";
export const PASSWORD = "ABCD0123EFGH4567JKMN89PQ";
export const DIR = "dir-table";
export const MAIL = "mail-table";

type Item = Record<string, unknown>;
type Key = { pk: unknown; sk: unknown };

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const ddbMock = mockClient(doc);

/** Splits on commas that aren't inside parentheses. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts.filter(Boolean);
}

export class FakeDb {
  private tables = new Map<string, Map<string, Item>>();
  readonly deps: Deps;
  logs: string[] = [];

  constructor() {
    this.deps = {
      config: { directoryTable: DIR, mailTable: MAIL, mailBucket: "mail-bucket" },
      doc,
      now: () => NOW,
      log: (level, msg) => this.logs.push(`${level}: ${msg}`),
    };
    ddbMock.reset();
    ddbMock.on(GetCommand).callsFake((i) => ({ Item: this.get(i.TableName, i.Key) }));
    ddbMock.on(BatchGetCommand).callsFake((i) => ({
      Responses: Object.fromEntries(
        Object.entries(i.RequestItems as Record<string, { Keys: Key[] }>).map(([t, { Keys }]) => [
          t,
          Keys.map((k) => this.get(t, k)).filter(Boolean),
        ]),
      ),
    }));
    ddbMock.on(PutCommand).callsFake((i) => {
      this.check(i.TableName, i.Item as Key, i.ConditionExpression);
      this.put(i.TableName, i.Item);
      return {};
    });
    ddbMock.on(DeleteCommand).callsFake((i) => {
      this.check(i.TableName, i.Key, i.ConditionExpression);
      this.table(i.TableName).delete(this.id(i.Key));
      return {};
    });
    ddbMock.on(UpdateCommand).callsFake((i) => {
      this.check(i.TableName, i.Key, i.ConditionExpression);
      this.update(
        i.TableName,
        i.Key,
        i.UpdateExpression,
        i.ExpressionAttributeNames,
        i.ExpressionAttributeValues,
      );
      return {};
    });
  }

  private id(key: Key) {
    return `${String(key.pk)}|${String(key.sk)}`;
  }

  private table(name: string) {
    let t = this.tables.get(name);
    if (!t) {
      t = new Map();
      this.tables.set(name, t);
    }
    return t;
  }

  get(table: string, key: Key): Item | undefined {
    const item = this.table(table).get(this.id(key));
    return item ? structuredClone(item) : undefined;
  }

  put(table: string, item: Item) {
    this.table(table).set(this.id(item as Key), structuredClone(item));
  }

  delete(table: string, key: Key) {
    this.table(table).delete(this.id(key));
  }

  all(table: string, pkPrefix = ""): Item[] {
    return [...this.table(table).values()].filter((i) => String(i.pk).startsWith(pkPrefix));
  }

  private check(table: string, key: Key, condition: string | undefined) {
    if (!condition) return;
    const exists = this.table(table).has(this.id(key));
    if (/attribute_not_exists\(pk\)/.test(condition) && exists) throw conditionFailed();
    if (/attribute_exists\(pk\)/.test(condition) && !/not_exists/.test(condition) && !exists) {
      throw conditionFailed();
    }
  }

  private update(
    table: string,
    key: Key,
    expression: string,
    names: Record<string, string> = {},
    values: Record<string, unknown> = {},
  ) {
    const item: Item = this.get(table, key) ?? { pk: key.pk, sk: key.sk };
    const name = (n: string) => names[n] ?? n;
    for (const clause of expression.split(/\s*(?=\b(?:SET|ADD|REMOVE)\s)/)) {
      const [, verb, rest = ""] = clause.trim().match(/^(SET|ADD|REMOVE)\s+([\s\S]*)$/) ?? [];
      for (const part of splitTopLevel(rest)) {
        if (verb === "REMOVE") {
          delete item[name(part)];
        } else if (verb === "ADD") {
          const [field = "", value = ""] = part.split(/\s+/);
          item[name(field)] = Number(item[name(field)] ?? 0) + Number(values[value]);
        } else if (verb === "SET") {
          const [field = "", rhs = ""] = part.split(/\s*=\s*/);
          const ifNotExists = rhs.match(/^if_not_exists\(\s*([^,]+),\s*([^)]+)\)$/);
          if (ifNotExists) {
            const current = item[name((ifNotExists[1] as string).trim())];
            item[name(field)] = current ?? values[(ifNotExists[2] as string).trim()];
          } else {
            item[name(field)] = values[rhs];
          }
        }
      }
    }
    this.put(table, item);
  }

  /** Alice, owner of MBX, with app password PASSWORD for it. */
  seedAlice(): AppPasswordItem {
    const mailbox: MailboxItem = {
      ...directoryKeys.mailbox(MBX),
      type: "mailbox",
      mailboxId: MBX,
      primaryAddress: ALICE,
      displayName: "Alice",
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    const member: MemberItem = {
      ...directoryKeys.member(MBX, ALICE),
      type: "member",
      mailboxId: MBX,
      userId: ALICE,
      role: "owner",
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    const password: AppPasswordItem = {
      ...directoryKeys.appPassword(hashAppPassword(PASSWORD), ALICE, "pw1"),
      type: "app-password",
      id: "pw1",
      userId: ALICE,
      mailboxId: MBX,
      label: "Work iPhone",
      createdAt: "2026-11-01T00:00:00.000Z",
    };
    this.put(DIR, mailbox as unknown as Item);
    this.put(DIR, member as unknown as Item);
    this.put(DIR, password as unknown as Item);
    return password;
  }
}

function conditionFailed() {
  return new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
}

export function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export interface PostOptions {
  auth?: string;
  deviceId?: string;
  policyKey?: string;
  version?: string;
  ip?: string;
  raw?: Buffer;
}

/** Posts one command and decodes the WBXML answer (undefined when the response isn't WBXML). */
export async function post(db: FakeDb, cmd: string, body?: Element, opts: PostOptions = {}) {
  const app = createApp(async () => db.deps);
  const headers: Record<string, string> = {
    Authorization: opts.auth ?? basic(ALICE, PASSWORD),
    "MS-ASProtocolVersion": opts.version ?? "14.1",
    "Content-Type": WBXML_TYPE,
    "User-Agent": "Apple-iPhone17C1/2301.120",
    "X-Forwarded-For": opts.ip ?? "203.0.113.7",
  };
  if (opts.policyKey) headers["X-MS-PolicyKey"] = opts.policyKey;
  const deviceId = opts.deviceId ?? "ABC123";
  const res = await app.request(
    `/Microsoft-Server-ActiveSync?Cmd=${cmd}&User=alice&DeviceId=${deviceId}&DeviceType=iPhone`,
    { method: "POST", headers, body: opts.raw ?? (body ? new Uint8Array(encode(body)) : null) },
  );
  const bytes = Buffer.from(await res.arrayBuffer());
  const wbxml = res.headers.get("content-type") === WBXML_TYPE && bytes.length > 0;
  return { res, body: wbxml ? decode(bytes) : undefined };
}
