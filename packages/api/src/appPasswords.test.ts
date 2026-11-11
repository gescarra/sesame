import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  type AppPasswordItem,
  type AppPasswordsResponse,
  type CreateAppPasswordResponse,
  type DeviceItem,
  directoryKeys,
  hashAppPassword,
  normalizeAppPassword,
} from "@sesame/core";
import { beforeEach, describe, expect, it } from "vitest";
import { ddbMock, MBX, sessionCookie, type TestDeps, testApp, testDeps } from "./testing.ts";

const ALICE = "alice@example.com";
let deps: TestDeps;
let app: ReturnType<typeof testApp>;
let passwords: AppPasswordItem[];
let devices: DeviceItem[];

const member = {
  ...directoryKeys.member(MBX, ALICE),
  type: "member",
  mailboxId: MBX,
  userId: ALICE,
  role: "owner",
};
const mailbox = { ...directoryKeys.mailbox(MBX), type: "mailbox", mailboxId: MBX, primaryAddress: ALICE };

const password = (id: string, overrides: Partial<AppPasswordItem> = {}): AppPasswordItem => ({
  ...directoryKeys.appPassword(`hash-${id}`, ALICE, id),
  type: "app-password",
  id,
  userId: ALICE,
  mailboxId: MBX,
  label: `Phone ${id}`,
  createdAt: `2026-11-0${id.length % 9}T00:00:00.000Z`,
  ...overrides,
});

const device = (deviceId: string, passwordId: string): DeviceItem => ({
  ...directoryKeys.device(ALICE, deviceId),
  type: "device",
  userId: ALICE,
  deviceId,
  deviceType: "iPhone",
  passwordId,
  mailboxId: MBX,
  model: "iPhone17,1",
  os: "iOS 26.1",
  firstSeenAt: "2026-11-02T00:00:00.000Z",
  lastSeenAt: "2026-11-10T00:00:00.000Z",
});

const ID1 = "01M5ZJ32HDGDRJ5084ESAB24RW";
const ID2 = "01M5ZJ32HDGDRJ5084ESAB24RX";

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", sessionCookie(deps));
  if (init.method && init.method !== "GET") headers.set("x-requested-with", "sesame");
  if (init.body) headers.set("content-type", "application/json");
  return app.request(`/api/app-passwords${path}`, { ...init, headers });
}

beforeEach(() => {
  ddbMock.reset();
  deps = testDeps({ config: { ...testDeps().config, easServer: "eas.example.com" } });
  app = testApp(deps);
  passwords = [password(ID1), password(ID2, { createdAt: "2026-11-09T00:00:00.000Z" })];
  devices = [device("DEV1", ID1), device("DEV2", ID2)];

  ddbMock.on(GetCommand).callsFake((input) => ({
    Item: input.Key.pk === member.pk && input.Key.sk === member.sk ? member : undefined,
  }));
  ddbMock.on(BatchGetCommand).resolves({ Responses: { "dir-table": [mailbox] } });
  ddbMock.on(QueryCommand).callsFake((input) => {
    const v = input.ExpressionAttributeValues ?? {};
    if (input.IndexName === "gsi1" && v[":m"] === "MBX#") return { Items: [member] };
    if (input.IndexName === "gsi1" && input.KeyConditionExpression?.includes("begins_with"))
      return { Items: passwords };
    if (input.IndexName === "gsi1") return { Items: passwords.filter((p) => p.gsi1sk === v[":s"]) };
    if (v[":pk"] === `DEVICE#${ALICE}`) return { Items: devices };
    return { Items: [] };
  });
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
});

describe("app passwords", () => {
  it("creates one for a mailbox the user can open, stores only its hash, and shows it once", async () => {
    const res = await request("", {
      method: "POST",
      body: JSON.stringify({ mailboxId: MBX, label: "  Work iPhone " }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateAppPasswordResponse;
    expect(body.password).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(body.appPassword).toMatchObject({
      label: "Work iPhone",
      mailboxId: MBX,
      address: ALICE,
      devices: [],
    });

    const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item as AppPasswordItem;
    expect(item.pk).toBe(`APPPW#${hashAppPassword(normalizeAppPassword(body.password))}`);
    expect(JSON.stringify(item)).not.toContain(body.password.replace(/-/g, ""));
    expect(item).toMatchObject({ type: "app-password", userId: ALICE, gsi1pk: `USER#${ALICE}` });
  });

  it("refuses mailboxes the user can't open, missing names and more than ten passwords", async () => {
    const other = "01M5ZJ2GVN042RKXX2HW200C0R";
    const post = (body: unknown) => request("", { method: "POST", body: JSON.stringify(body) });
    expect((await post({ mailboxId: other, label: "x" })).status).toBe(404);
    expect((await post({ mailboxId: MBX, label: " " })).status).toBe(400);
    expect((await post({ mailboxId: MBX, label: "x".repeat(65) })).status).toBe(400);
    passwords = Array.from({ length: 10 }, (_, i) => password(`P${i}`));
    expect((await post({ mailboxId: MBX, label: "x" })).status).toBe(422);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("lists passwords newest first, each with its devices, and the server to type in", async () => {
    const res = await request("");
    const body = (await res.json()) as AppPasswordsResponse;
    expect(body.server).toBe("eas.example.com");
    expect(body.passwords.map((p) => [p.id, p.address, p.devices.map((d) => d.deviceId)])).toEqual([
      [ID2, ALICE, ["DEV2"]],
      [ID1, ALICE, ["DEV1"]],
    ]);
    expect(body.passwords[0]?.devices[0]).toEqual({
      deviceId: "DEV2",
      deviceType: "iPhone",
      model: "iPhone17,1",
      os: "iOS 26.1",
      firstSeenAt: "2026-11-02T00:00:00.000Z",
      lastSeenAt: "2026-11-10T00:00:00.000Z",
    });
  });

  it("revokes a password and forgets its devices, leaving the others", async () => {
    const res = await request(`/${ID1}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const deleted = ddbMock.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key?.pk);
    expect(deleted.sort()).toEqual([`APPPW#hash-${ID1}`, `DEVICE#${ALICE}`]);
    expect(ddbMock.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key?.sk)).toContain("DEV1");
    expect((await request("/01M5ZJ32HDGDRJ5084ESAB24RZ", { method: "DELETE" })).status).toBe(404);
  });
});
