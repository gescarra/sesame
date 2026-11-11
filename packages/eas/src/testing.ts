// Test fixtures: in-memory stand-ins for the DynamoDB document client and S3, and a request helper.
// The DynamoDB fake understands the expressions sesame's ActiveSync code writes: SET (including
// if_not_exists), ADD and REMOVE; conditions joined by AND or OR of attribute_exists,
// attribute_not_exists, equality and "<"; GSI1 folder queries, prefix queries on the table, and
// transactions. Time is a fake clock that deps.sleep moves.
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  type AppPasswordItem,
  type DeviceItem,
  directoryKeys,
  hashAppPassword,
  type MailboxItem,
  type MemberItem,
  type MessageItem,
  mailKeys,
  messageObjectPrefix,
  type SystemFolder,
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
export const POLICY_KEY = "1234567890";

type Item = Record<string, unknown>;
type Key = { pk: unknown; sk: unknown };

export const BUCKET = "mail-bucket";
export const INGEST_QUEUE = "https://sqs.test/ingest";
export const SEND_QUEUE = "https://sqs.test/send";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const ddbMock = mockClient(doc);
const s3 = new S3Client({ region: "us-east-1" });
const s3Mock = mockClient(s3);
const sqs = new SQSClient({ region: "us-east-1" });
const sqsMock = mockClient(sqs);

type Names = Record<string, string> | undefined;
type Values = Record<string, unknown> | undefined;

/** One write in a transaction. */
interface Op {
  TableName: string;
  Key?: Key;
  Item?: Item;
  ConditionExpression?: string;
  UpdateExpression?: string;
  ExpressionAttributeNames?: Names;
  ExpressionAttributeValues?: Values;
}
type TransactItem = { Put?: Op; Update?: Op; Delete?: Op; ConditionCheck?: Op };

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

  /** S3 objects by key. */
  objects = new Map<string, { body: Buffer; contentType?: string }>();
  /** SQS messages sent, parsed, with their queue. */
  queued: { queue: string; job: Record<string, unknown> }[] = [];
  /** The fake clock: deps.now reads it and deps.sleep moves it. */
  clock = NOW;
  /** Runs on every sleep, after the clock moves: tests use it to change things mid-Ping. */
  onSleep: ((clock: number) => void) | undefined;

  constructor() {
    this.deps = {
      config: {
        directoryTable: DIR,
        mailTable: MAIL,
        mailBucket: BUCKET,
        ingestQueueUrl: INGEST_QUEUE,
        sendQueueUrl: SEND_QUEUE,
        sendRateLimit: 200,
        push: false,
      },
      doc,
      s3,
      sqs,
      now: () => this.clock,
      sleep: async (ms) => {
        this.clock += ms;
        this.onSleep?.(this.clock);
      },
      log: (level, msg) => this.logs.push(`${level}: ${msg}`),
    };
    ddbMock.reset();
    s3Mock.reset();
    sqsMock.reset();
    sqsMock.on(SendMessageCommand).callsFake((i) => {
      this.queued.push({ queue: i.QueueUrl, job: JSON.parse(i.MessageBody) });
      return { MessageId: `m${this.queued.length}` };
    });
    s3Mock.on(PutObjectCommand).callsFake((i) => {
      this.objects.set(i.Key, { body: Buffer.from(i.Body as Buffer), contentType: i.ContentType });
      return {};
    });
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
      this.check(
        i.TableName,
        i.Item as Key,
        i.ConditionExpression,
        i.ExpressionAttributeNames,
        i.ExpressionAttributeValues,
      );
      this.put(i.TableName, i.Item);
      return {};
    });
    ddbMock.on(DeleteCommand).callsFake((i) => {
      this.check(
        i.TableName,
        i.Key,
        i.ConditionExpression,
        i.ExpressionAttributeNames,
        i.ExpressionAttributeValues,
      );
      this.table(i.TableName).delete(this.id(i.Key));
      return {};
    });
    ddbMock.on(UpdateCommand).callsFake((i) => {
      this.check(
        i.TableName,
        i.Key,
        i.ConditionExpression,
        i.ExpressionAttributeNames,
        i.ExpressionAttributeValues,
      );
      this.update(
        i.TableName,
        i.Key,
        i.UpdateExpression,
        i.ExpressionAttributeNames,
        i.ExpressionAttributeValues,
      );
      return {};
    });
    ddbMock.on(TransactWriteCommand).callsFake((i) => {
      // Every condition is checked before anything is written.
      const reasons = (i.TransactItems as TransactItem[]).map((t) => {
        const op = t.Put ?? t.Update ?? t.Delete ?? t.ConditionCheck;
        if (!op) return { Code: "None" };
        const key = (op.Key ?? op.Item) as Key;
        const ok = this.evaluate(
          this.get(op.TableName, key),
          op.ConditionExpression,
          op.ExpressionAttributeNames,
          op.ExpressionAttributeValues,
        );
        return { Code: ok ? "None" : "ConditionalCheckFailed" };
      });
      if (reasons.some((r) => r.Code !== "None")) {
        throw new TransactionCanceledException({
          message: "Transaction cancelled",
          $metadata: {},
          CancellationReasons: reasons,
        });
      }
      for (const t of i.TransactItems as TransactItem[]) {
        if (t.Put?.Item) this.put(t.Put.TableName, t.Put.Item);
        if (t.Delete?.Key) this.delete(t.Delete.TableName, t.Delete.Key);
        if (t.Update?.Key && t.Update.UpdateExpression) {
          this.update(
            t.Update.TableName,
            t.Update.Key,
            t.Update.UpdateExpression,
            t.Update.ExpressionAttributeNames,
            t.Update.ExpressionAttributeValues,
          );
        }
      }
      return {};
    });
    ddbMock.on(QueryCommand).callsFake((i) => this.query(i));

    s3Mock.on(GetObjectCommand).callsFake((i) => {
      const object = this.objects.get(i.Key);
      if (!object) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
      const range = /^bytes=(\d+)-(\d+)$/.exec(i.Range ?? "");
      const body = range ? object.body.subarray(Number(range[1]), Number(range[2]) + 1) : object.body;
      return {
        Body: {
          transformToByteArray: async () => new Uint8Array(body),
          transformToString: async () => body.toString("utf8"),
        },
        ContentLength: body.length,
        ...(range
          ? { ContentRange: `bytes ${range[1]}-${Number(range[1]) + body.length - 1}/${object.body.length}` }
          : {}),
        ...(object.contentType ? { ContentType: object.contentType } : {}),
      };
    });
    s3Mock.on(ListObjectsV2Command).callsFake((i) => ({
      Contents: [...this.objects.keys()].filter((k) => k.startsWith(i.Prefix ?? "")).map((Key) => ({ Key })),
    }));
    s3Mock.on(DeleteObjectsCommand).callsFake((i) => {
      for (const o of i.Delete?.Objects ?? []) this.objects.delete(o.Key);
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

  private check(table: string, key: Key, condition: string | undefined, names: Names, values: Values) {
    if (!this.evaluate(this.get(table, key), condition, names, values)) throw conditionFailed();
  }

  private evaluate(
    item: Item | undefined,
    condition: string | undefined,
    names: Names,
    values: Values,
  ): boolean {
    if (!condition) return true;
    const name = (n: string) => names?.[n] ?? n;
    if (/\s+OR\s+/.test(condition)) {
      return condition.split(/\s+OR\s+/).some((c) => this.evaluate(item, c, names, values));
    }
    return condition.split(/\s+AND\s+/).every((clause) => {
      const exists = clause.match(/^attribute_exists\((.+)\)$/);
      if (exists) return item !== undefined && item[name(exists[1] as string)] !== undefined;
      const notExists = clause.match(/^attribute_not_exists\((.+)\)$/);
      if (notExists) return item === undefined || item[name(notExists[1] as string)] === undefined;
      const equals = clause.match(/^(\S+)\s*=\s*(:\w+)$/);
      if (equals)
        return item !== undefined && item[name(equals[1] as string)] === values?.[equals[2] as string];
      const less = clause.match(/^(\S+)\s*<\s*(:\w+)$/);
      if (less)
        return (
          item !== undefined && Number(item[name(less[1] as string)]) < Number(values?.[less[2] as string])
        );
      throw new Error(`FakeDb can't evaluate ${clause}`);
    });
  }

  /**
   * GSI1 queries: "gsi1pk = :p", optionally "AND gsi1sk >= :since"; and on the table,
   * "pk = :pk AND begins_with(sk, :f)".
   */
  private query(i: QueryCommandInput) {
    const values = i.ExpressionAttributeValues as Record<string, string>;
    const condition = i.KeyConditionExpression ?? "";
    if (!i.IndexName && condition === "pk = :pk AND begins_with(sk, :f)") {
      const items = [...this.table(i.TableName ?? "").values()]
        .filter((it) => it.pk === values[":pk"] && String(it.sk).startsWith(values[":f"] as string))
        .sort((a, b) => (String(a.sk) < String(b.sk) ? -1 : 1));
      return { Items: items.map((it) => structuredClone(it)) };
    }
    if (i.IndexName !== "gsi1" || !/^gsi1pk = :p( AND gsi1sk >= :since)?$/.test(condition)) {
      throw new Error(`FakeDb can't run query ${condition}`);
    }
    const since = values[":since"];
    const matches = [...this.table(i.TableName ?? "").values()]
      .filter((it) => it.gsi1pk === values[":p"] && (since === undefined || String(it.gsi1sk) >= since))
      .sort((a, b) => (String(a.gsi1sk) < String(b.gsi1sk) ? -1 : 1));
    if (i.ScanIndexForward === false) matches.reverse();
    const start = i.ExclusiveStartKey ? matches.findIndex((it) => it.sk === i.ExclusiveStartKey?.sk) + 1 : 0;
    const limit = i.Limit ?? matches.length;
    const page = matches.slice(start, start + limit);
    const last = page.at(-1);
    return {
      Items: page.map((it) => structuredClone(it)),
      ...(start + limit < matches.length && last
        ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk, gsi1pk: last.gsi1pk, gsi1sk: last.gsi1sk } }
        : {}),
    };
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
    this.put(DIR, { ...directoryKeys.domain("example.com"), type: "domain", domain: "example.com" });
    this.put(DIR, { ...directoryKeys.address(ALICE), type: "address", mailboxId: MBX, kind: "primary" });
    this.put(DIR, password as unknown as Item);
    return password;
  }

  /**
   * A message in Alice's mailbox with its objects in S3: message.eml (`mime`), body.json and one
   * attachment per entry in `attachments`.
   */
  seedMessage(ulid: string, overrides: Partial<MessageItem> & { mime?: string } = {}): MessageItem {
    const { mime, ...fields } = overrides;
    const folder: SystemFolder = fields.folder ?? "inbox";
    const raw = Buffer.from(
      mime ??
        `From: Bob <bob@example.net>\r\nTo: alice@example.com\r\nSubject: Hello ${ulid}\r\n\r\nHi Alice.\r\n`,
    );
    const prefix = messageObjectPrefix(MBX, ulid);
    const item: MessageItem = {
      ...mailKeys.message(MBX, ulid),
      ...mailKeys.folderView(MBX, folder, ulid),
      ...mailKeys.threadView(MBX, ulid, ulid),
      type: "message",
      mailboxId: MBX,
      messageUlid: ulid,
      folder,
      threadId: ulid,
      from: { name: "Bob", address: "bob@example.net" },
      to: [{ address: ALICE }],
      cc: [],
      subject: `Hello ${ulid}`,
      snippet: "Hi Alice.",
      date: "2026-11-10T09:00:00.000Z",
      receivedAt: "2026-11-10T09:00:00.000Z",
      size: raw.length,
      read: false,
      flagged: false,
      hasAttachments: false,
      attachments: [],
      objectPrefix: prefix,
      ...fields,
    };
    if (item.flagged) Object.assign(item, mailKeys.flaggedView(MBX, ulid));
    this.put(MAIL, item as unknown as Item);
    this.objects.set(`${prefix}message.eml`, { body: raw, contentType: "message/rfc822" });
    this.objects.set(`${prefix}body.json`, { body: Buffer.from(JSON.stringify({ text: "Hi Alice." })) });
    for (const a of item.attachments) {
      this.objects.set(`${prefix}att/${a.partId}`, {
        body: Buffer.alloc(a.size, 0x61),
        contentType: a.contentType,
      });
    }
    return item;
  }

  /** Alice's phone ABC123, already provisioned with POLICY_KEY. */
  seedDevice(): DeviceItem {
    const device: DeviceItem = {
      ...directoryKeys.device(ALICE, "ABC123"),
      type: "device",
      userId: ALICE,
      deviceId: "ABC123",
      deviceType: "iPhone",
      passwordId: "pw1",
      mailboxId: MBX,
      userAgent: "Apple-iPhone17C1/2301.120",
      policyKey: POLICY_KEY,
      firstSeenAt: new Date(NOW).toISOString(),
      lastSeenAt: new Date(NOW).toISOString(),
    };
    this.put(DIR, device as unknown as Item);
    return device;
  }

  message(ulid: string): MessageItem | undefined {
    return this.get(MAIL, mailKeys.message(MBX, ulid)) as MessageItem | undefined;
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
  headers?: Record<string, string>;
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
  Object.assign(headers, opts.headers);
  const deviceId = opts.deviceId ?? "ABC123";
  const res = await app.request(
    `/Microsoft-Server-ActiveSync?Cmd=${cmd}&User=alice&DeviceId=${deviceId}&DeviceType=iPhone`,
    { method: "POST", headers, body: opts.raw ?? (body ? new Uint8Array(encode(body)) : null) },
  );
  const bytes = Buffer.from(await res.arrayBuffer());
  const wbxml = res.headers.get("content-type") === WBXML_TYPE && bytes.length > 0;
  return { res, bytes, body: wbxml ? decode(bytes) : undefined };
}
