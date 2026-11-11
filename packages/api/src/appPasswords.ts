// App passwords for phones (ActiveSync), and the devices that used them. A signed-in user
// creates one per mailbox they can open; the password is shown once and stored as a hash.
import { DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  type AppPasswordItem,
  type AppPasswordSummary,
  type AppPasswordsResponse,
  type CreateAppPasswordResponse,
  type DeviceItem,
  directoryKeys,
  formatAppPassword,
  hashAppPassword,
  MAX_APP_PASSWORD_LABEL,
  MAX_APP_PASSWORDS,
  newAppPassword,
  newUlid,
  USER_INDEX,
} from "@sesame/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Deps, Env } from "./deps.ts";
import { getMembership, listMailboxes } from "./mail.ts";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const appPasswordRoutes = new Hono<Env>();

appPasswordRoutes.get("/", async (c) => {
  const { deps, user } = c.var;
  return c.json(await listAppPasswords(deps, user.email));
});

appPasswordRoutes.post("/", async (c) => {
  const { deps, user } = c.var;
  const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  const mailboxId = body?.mailboxId;
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  if (typeof mailboxId !== "string" || !ULID.test(mailboxId)) {
    throw new HTTPException(400, { message: "mailboxId is required" });
  }
  if (!label || label.length > MAX_APP_PASSWORD_LABEL) {
    throw new HTTPException(400, {
      message: `give the password a name of 1-${MAX_APP_PASSWORD_LABEL} characters`,
    });
  }
  if (!(await getMembership(deps, mailboxId, user.email))) {
    throw new HTTPException(404, { message: "mailbox not found" });
  }
  if ((await queryPasswords(deps, user.email)).length >= MAX_APP_PASSWORDS) {
    throw new HTTPException(422, {
      message: `you already have ${MAX_APP_PASSWORDS} app passwords: revoke one you no longer use first`,
    });
  }

  const password = newAppPassword();
  const now = deps.now();
  const id = newUlid(now);
  const item: AppPasswordItem = {
    ...directoryKeys.appPassword(hashAppPassword(password), user.email, id),
    type: "app-password",
    id,
    userId: user.email,
    mailboxId,
    label,
    createdAt: new Date(now).toISOString(),
  };
  await deps.doc.send(
    new PutCommand({
      TableName: deps.config.directoryTable,
      Item: item,
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );
  deps.log("info", "app password created", { sub: user.sub, id, mailboxId });
  const mailboxes = await listMailboxes(deps, user.email);
  const response: CreateAppPasswordResponse = {
    password: formatAppPassword(password),
    appPassword: summarize(item, [], mailboxes.find((m) => m.mailboxId === mailboxId)?.address),
  };
  return c.json(response, 201);
});

appPasswordRoutes.delete("/:id", async (c) => {
  const { deps, user } = c.var;
  const id = c.req.param("id");
  const item = ULID.test(id) ? (await queryPasswords(deps, user.email, id))[0] : undefined;
  if (!item) throw new HTTPException(404, { message: "app password not found" });
  const { directoryTable } = deps.config;
  await deps.doc.send(new DeleteCommand({ TableName: directoryTable, Key: { pk: item.pk, sk: item.sk } }));
  // Its devices stop working at once; their records go too.
  const devices = (await queryDevices(deps, user.email)).filter((d) => d.passwordId === id);
  await Promise.all(
    devices.map((d) =>
      deps.doc.send(new DeleteCommand({ TableName: directoryTable, Key: { pk: d.pk, sk: d.sk } })),
    ),
  );
  deps.log("info", "app password revoked", { sub: user.sub, id, devices: devices.length });
  return c.json({ ok: true });
});

export async function listAppPasswords(deps: Deps, email: string): Promise<AppPasswordsResponse> {
  const [passwords, devices, mailboxes] = await Promise.all([
    queryPasswords(deps, email),
    queryDevices(deps, email),
    listMailboxes(deps, email),
  ]);
  const address = new Map(mailboxes.map((m) => [m.mailboxId, m.address]));
  return {
    server: deps.config.easServer ?? null,
    passwords: passwords
      .map((p) =>
        summarize(
          p,
          devices.filter((d) => d.passwordId === p.id),
          address.get(p.mailboxId),
        ),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

/** A user's app passwords, or the one with this id. */
async function queryPasswords(deps: Deps, email: string, id?: string): Promise<AppPasswordItem[]> {
  const keys = directoryKeys.appPassword("", email, id ?? "");
  const res = await deps.doc.send(
    new QueryCommand({
      TableName: deps.config.directoryTable,
      IndexName: "gsi1",
      KeyConditionExpression: id ? "gsi1pk = :u AND gsi1sk = :s" : "gsi1pk = :u AND begins_with(gsi1sk, :s)",
      ExpressionAttributeValues: { ":u": keys.gsi1pk, ":s": id ? keys.gsi1sk : USER_INDEX.appPassword },
    }),
  );
  return (res.Items ?? []) as AppPasswordItem[];
}

async function queryDevices(deps: Deps, email: string): Promise<DeviceItem[]> {
  const res = await deps.doc.send(
    new QueryCommand({
      TableName: deps.config.directoryTable,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": directoryKeys.device(email, "").pk },
    }),
  );
  return (res.Items ?? []) as DeviceItem[];
}

function summarize(
  item: AppPasswordItem,
  devices: DeviceItem[],
  address: string | undefined,
): AppPasswordSummary {
  const summary: AppPasswordSummary = {
    id: item.id,
    label: item.label,
    mailboxId: item.mailboxId,
    createdAt: item.createdAt,
    devices: devices
      .map((d) => {
        const device: AppPasswordSummary["devices"][number] = {
          deviceId: d.deviceId,
          deviceType: d.deviceType,
          firstSeenAt: d.firstSeenAt,
          lastSeenAt: d.lastSeenAt,
        };
        const model = d.friendlyName ?? d.model;
        if (model) device.model = model;
        if (d.os) device.os = d.os;
        return device;
      })
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
  };
  if (address) summary.address = address;
  if (item.lastUsedAt) summary.lastUsedAt = item.lastUsedAt;
  return summary;
}
