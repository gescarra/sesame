// Sign-in for ActiveSync clients: HTTP Basic with an app password, on every request.
// Access follows mailbox membership, checked each time, so removing a member in the admin
// console cuts their phones off at once. Failed attempts are throttled per username and per IP.
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  type AppPasswordItem,
  batchGet,
  type DeviceItem,
  directoryKeys,
  getItem,
  hashAppPassword,
  isWellFormedAppPassword,
  type MemberItem,
  normalizeAddress,
  normalizeAppPassword,
} from "@sesame/core";
import type { Deps } from "./deps.ts";

/** Failures within one window before new devices are turned away for the rest of it. */
export const MAX_FAILURES = 10;
const WINDOW_SECONDS = 15 * 60;
const TOUCH_MS = 60 * 60 * 1000;

export interface Session {
  userId: string;
  mailboxId: string;
  passwordId: string;
  /** Absent only for requests without a DeviceId (OPTIONS). */
  device?: DeviceItem;
}

export interface Credentials {
  username: string;
  password: string;
}

export function parseBasic(header: string | undefined): Credentials | undefined {
  const match = header?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!match) return undefined;
  const decoded = Buffer.from(match[1] as string, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return undefined;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/**
 * iOS sends the username as typed: the email address, `DOMAIN\user`, or a bare local part.
 * Any of them must name the password's owner.
 */
export function usernameMatches(username: string, userId: string): boolean {
  const name = username.trim().replace(/^.*\\/, "").toLowerCase();
  if (!name) return false;
  if (name.includes("@")) return normalizeAddress(name) === userId;
  return name === userId.slice(0, userId.lastIndexOf("@"));
}

export interface AuthInput {
  authorization: string | undefined;
  ip: string;
  device?: { deviceId: string; deviceType: string; userAgent?: string };
}

export async function authenticate(deps: Deps, input: AuthInput): Promise<Session | undefined> {
  const creds = parseBasic(input.authorization);
  if (!creds) return undefined;
  const subjects = failureSubjects(creds.username, input.ip);

  const normalized = normalizeAppPassword(creds.password);
  const password = isWellFormedAppPassword(normalized)
    ? await findPassword(deps, hashAppPassword(normalized))
    : undefined;
  if (!password || !usernameMatches(creds.username, password.userId)) {
    await recordFailure(deps, subjects);
    deps.log("warn", "ActiveSync sign-in failed", { reason: password ? "username" : "password" });
    return undefined;
  }

  const { directoryTable } = deps.config;
  const deviceKey = input.device ? directoryKeys.device(password.userId, input.device.deviceId) : undefined;
  const memberKey = directoryKeys.member(password.mailboxId, password.userId);
  const items = await batchGet(deps.doc, directoryTable, [
    { pk: memberKey.pk, sk: memberKey.sk },
    ...(deviceKey ? [deviceKey] : []),
  ]);
  const member = items.find((i) => i.pk === memberKey.pk) as MemberItem | undefined;
  let device = deviceKey ? (items.find((i) => i.pk === deviceKey.pk) as DeviceItem | undefined) : undefined;
  if (!member) {
    // The password is right, but its owner lost access to the mailbox.
    deps.log("warn", "ActiveSync sign-in without mailbox access", { passwordId: password.id });
    return undefined;
  }
  // A device that has signed in before keeps working while its username or IP is locked out,
  // so guessing can't lock out a working phone.
  if (!device && (await isLockedOut(deps, subjects))) {
    deps.log("warn", "ActiveSync sign-in refused: too many failures");
    return undefined;
  }

  const now = deps.now();
  await touchPassword(deps, password, now);
  if (input.device) device = await upsertDevice(deps, password, input.device, device, now);
  const session: Session = {
    userId: password.userId,
    mailboxId: password.mailboxId,
    passwordId: password.id,
  };
  if (device) session.device = device;
  return session;
}

async function findPassword(deps: Deps, hash: string): Promise<AppPasswordItem | undefined> {
  return getItem<AppPasswordItem>(
    deps.doc,
    deps.config.directoryTable,
    directoryKeys.appPasswordByHash(hash),
  );
}

function failureSubjects(username: string, ip: string): string[] {
  return [`user:${username.trim().toLowerCase().slice(0, 256)}`, `ip:${ip}`];
}

function failureWindow(now: number): string {
  return String(Math.floor(now / 1000 / WINDOW_SECONDS));
}

async function recordFailure(deps: Deps, subjects: string[]) {
  const now = deps.now();
  const window = failureWindow(now);
  await Promise.all(
    subjects.map((s) =>
      deps.doc.send(
        new UpdateCommand({
          TableName: deps.config.directoryTable,
          Key: directoryKeys.authFailures(s, window),
          UpdateExpression: "ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)",
          ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
          ExpressionAttributeValues: { ":one": 1, ":ttl": Math.floor(now / 1000) + 2 * WINDOW_SECONDS },
        }),
      ),
    ),
  );
}

async function isLockedOut(deps: Deps, subjects: string[]): Promise<boolean> {
  const window = failureWindow(deps.now());
  const counters = await batchGet(
    deps.doc,
    deps.config.directoryTable,
    subjects.map((s) => directoryKeys.authFailures(s, window)),
  );
  return counters.some((c) => Number(c.count ?? 0) >= MAX_FAILURES);
}

async function touchPassword(deps: Deps, password: AppPasswordItem, now: number) {
  if (password.lastUsedAt && now - Date.parse(password.lastUsedAt) < TOUCH_MS) return;
  await deps.doc.send(
    new UpdateCommand({
      TableName: deps.config.directoryTable,
      Key: { pk: password.pk, sk: password.sk },
      UpdateExpression: "SET #lastUsedAt = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#lastUsedAt": "lastUsedAt" },
      ExpressionAttributeValues: { ":now": new Date(now).toISOString() },
    }),
  );
}

async function upsertDevice(
  deps: Deps,
  password: AppPasswordItem,
  seen: NonNullable<AuthInput["device"]>,
  device: DeviceItem | undefined,
  now: number,
): Promise<DeviceItem> {
  const at = new Date(now).toISOString();
  if (!device) {
    const item: DeviceItem = {
      ...directoryKeys.device(password.userId, seen.deviceId),
      type: "device",
      userId: password.userId,
      deviceId: seen.deviceId,
      deviceType: seen.deviceType,
      passwordId: password.id,
      mailboxId: password.mailboxId,
      firstSeenAt: at,
      lastSeenAt: at,
    };
    if (seen.userAgent) item.userAgent = seen.userAgent.slice(0, 256);
    // Two first requests can race; either write describes the same device.
    await deps.doc.send(new PutCommand({ TableName: deps.config.directoryTable, Item: item }));
    return item;
  }
  const changes: Partial<DeviceItem> = {};
  if (device.passwordId !== password.id) {
    // Signed in with another password, possibly for another mailbox: provision again.
    Object.assign(changes, { passwordId: password.id, mailboxId: password.mailboxId, policyKey: undefined });
  }
  if (seen.userAgent && seen.userAgent.slice(0, 256) !== device.userAgent) {
    changes.userAgent = seen.userAgent.slice(0, 256);
  }
  if (Object.keys(changes).length || now - Date.parse(device.lastSeenAt) >= TOUCH_MS) {
    changes.lastSeenAt = at;
    return updateDevice(deps, device, changes);
  }
  return device;
}

/** Sets the given fields on a device record; undefined values remove the attribute. */
export async function updateDevice(
  deps: Deps,
  device: DeviceItem,
  changes: Partial<DeviceItem>,
): Promise<DeviceItem> {
  const set: string[] = [];
  const remove: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  Object.entries(changes).forEach(([field, value], i) => {
    names[`#f${i}`] = field;
    if (value === undefined) {
      remove.push(`#f${i}`);
    } else {
      set.push(`#f${i} = :v${i}`);
      values[`:v${i}`] = value;
    }
  });
  if (!set.length && !remove.length) return device;
  const expression = [
    set.length ? `SET ${set.join(", ")}` : "",
    remove.length ? `REMOVE ${remove.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  await deps.doc.send(
    new UpdateCommand({
      TableName: deps.config.directoryTable,
      Key: { pk: device.pk, sk: device.sk },
      UpdateExpression: expression,
      ExpressionAttributeNames: names,
      ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
    }),
  );
  const next = { ...device, ...changes };
  for (const [field, value] of Object.entries(changes)) {
    if (value === undefined) delete (next as Record<string, unknown>)[field];
  }
  return next;
}
