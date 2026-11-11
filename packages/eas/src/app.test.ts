import { type DeviceItem, directoryKeys, formatAppPassword, hashAppPassword } from "@sesame/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { MAX_FAILURES } from "./auth.ts";
import { ALICE, basic, DIR, FakeDb, MBX, PASSWORD, post } from "./testing.ts";
import { child, children, childText, el } from "./wbxml/codec.ts";

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  db.seedAlice();
});

const device = () => db.get(DIR, directoryKeys.device(ALICE, "ABC123")) as DeviceItem | undefined;

const provisionRequest = (policyKey?: string) =>
  el("Provision:Provision", [
    el("Settings:DeviceInformation", [
      el("Settings:Set", [el("Settings:Model", "iPhone17,1"), el("Settings:OS", "iOS 26.1 23B85")]),
    ]),
    el("Provision:Policies", [
      el("Provision:Policy", [
        el("Provision:PolicyType", "MS-EAS-Provisioning-WBXML"),
        policyKey !== undefined && el("Provision:PolicyKey", policyKey),
        policyKey !== undefined && el("Provision:Status", 1),
      ]),
    ]),
  ]);

/** Runs both Provision rounds and returns the final policy key. */
async function provisioned(): Promise<string> {
  const first = await post(db, "Provision", provisionRequest());
  const temp = childText(
    child(child(first.body, "Provision:Policies"), "Provision:Policy"),
    "Provision:PolicyKey",
  );
  const second = await post(db, "Provision", provisionRequest(temp ?? ""), { policyKey: temp ?? "" });
  return (
    childText(child(child(second.body, "Provision:Policies"), "Provision:Policy"), "Provision:PolicyKey") ??
    ""
  );
}

const folderSync = (key: string) => el("FolderHierarchy:FolderSync", [el("FolderHierarchy:SyncKey", key)]);

describe("OPTIONS", () => {
  const options = (auth?: string) =>
    createApp(async () => db.deps).request("/Microsoft-Server-ActiveSync", {
      method: "OPTIONS",
      headers: auth ? { Authorization: auth } : {},
    });

  it("asks for credentials", async () => {
    const res = await options();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="sesame"');
  });

  it("advertises the version and the implemented commands once signed in", async () => {
    const res = await options(basic(ALICE, PASSWORD));
    expect(res.status).toBe(200);
    expect(res.headers.get("ms-asprotocolversions")).toBe("14.1");
    expect(res.headers.get("ms-asprotocolcommands")).toBe(
      "Provision,Settings,FolderSync,Sync,GetItemEstimate,ItemOperations,MoveItems",
    );
  });
});

describe("sign-in", () => {
  it("accepts the email, DOMAIN\\user or the bare local part, and the password as displayed", async () => {
    for (const user of [ALICE, "ALICE@Example.com", "EXAMPLE\\alice", "alice"]) {
      const { res } = await post(db, "FolderSync", folderSync("0"), { auth: basic(user, PASSWORD) });
      expect(res.status, user).toBe(200);
    }
    const { res } = await post(db, "FolderSync", folderSync("0"), {
      auth: basic(ALICE, formatAppPassword(PASSWORD).toLowerCase()),
    });
    expect(res.status).toBe(200);
  });

  it("refuses a wrong password or someone else's username, and counts the failures", async () => {
    expect((await post(db, "FolderSync", undefined, { auth: basic(ALICE, "nope") })).res.status).toBe(401);
    expect(
      (await post(db, "FolderSync", undefined, { auth: basic("bob@example.com", PASSWORD) })).res.status,
    ).toBe(401);
    const counters = db.all(DIR, "AUTHFAIL#");
    expect(counters.map((c) => [String(c.pk).split("#")[1], c.count]).sort()).toEqual([
      ["ip:203.0.113.7", 2],
      ["user:alice@example.com", 1],
      ["user:bob@example.com", 1],
    ]);
    expect(device()).toBeUndefined();
  });

  it("refuses a correct password once its owner lost access to the mailbox", async () => {
    const member = directoryKeys.member(MBX, ALICE);
    db.delete(DIR, { pk: member.pk, sk: member.sk });
    expect((await post(db, "FolderSync")).res.status).toBe(401);
  });

  it("turns new devices away after too many failures, but not one that already signed in", async () => {
    await post(db, "FolderSync", folderSync("0")); // ABC123 becomes known
    for (let i = 0; i < MAX_FAILURES; i++)
      await post(db, "FolderSync", undefined, { auth: basic(ALICE, "bad") });
    expect((await post(db, "FolderSync", folderSync("0"), { deviceId: "NEW999" })).res.status).toBe(401);
    expect((await post(db, "FolderSync", folderSync("0"))).res.status).toBe(200);
  });

  it("records the device on its first request", async () => {
    await post(db, "FolderSync", folderSync("0"));
    expect(device()).toMatchObject({
      type: "device",
      userId: ALICE,
      deviceId: "ABC123",
      deviceType: "iPhone",
      passwordId: "pw1",
      mailboxId: MBX,
      userAgent: "Apple-iPhone17C1/2301.120",
    });
  });
});

describe("requests", () => {
  it("rejects a malformed DeviceId and an unsupported protocol version", async () => {
    expect((await post(db, "FolderSync", undefined, { deviceId: "a-b" })).res.status).toBe(400);
    const { res } = await post(db, "FolderSync", undefined, { version: "2.5" });
    expect(res.status).toBe(400);
    expect(res.headers.get("ms-asprotocolversions")).toBe("14.1");
  });

  it("answers 501 for commands that aren't implemented yet", async () => {
    expect((await post(db, "SendMail", undefined)).res.status).toBe(501);
  });

  it("answers status 102 for a body that isn't WBXML", async () => {
    const key = await provisioned();
    const { body } = await post(db, "FolderSync", undefined, { policyKey: key, raw: Buffer.from("<xml/>") });
    expect(childText(body, "FolderHierarchy:Status")).toBe("102");
  });

  it("only serves /Microsoft-Server-ActiveSync, in any case", async () => {
    const app = createApp(async () => db.deps);
    expect((await app.request("/api/me")).status).toBe(404);
    const res = await app.request("/microsoft-server-activesync", {
      method: "OPTIONS",
      headers: { Authorization: basic(ALICE, PASSWORD) },
    });
    expect(res.status).toBe(200);
  });
});

describe("Provision", () => {
  it("asks an unprovisioned device to provision (142), and a stale key to refresh (144)", async () => {
    const before = await post(db, "FolderSync", folderSync("0"));
    expect(childText(before.body, "FolderHierarchy:Status")).toBe("142");
    await provisioned();
    const stale = await post(db, "FolderSync", folderSync("0"), { policyKey: "12345" });
    expect(childText(stale.body, "FolderHierarchy:Status")).toBe("144");
  });

  it("hands out the policy with a temporary key, then a final key once acknowledged", async () => {
    const first = await post(db, "Provision", provisionRequest());
    expect(childText(first.body, "Provision:Status")).toBe("1");
    expect(childText(child(first.body, "Settings:DeviceInformation"), "Settings:Status")).toBe("1");
    const policy = child(child(first.body, "Provision:Policies"), "Provision:Policy");
    expect(childText(policy, "Provision:Status")).toBe("1");
    const temp = childText(policy, "Provision:PolicyKey") ?? "";
    const doc = child(child(policy, "Provision:Data"), "Provision:EASProvisionDoc");
    expect(childText(doc, "Provision:DevicePasswordEnabled")).toBe("0");
    expect(device()).toMatchObject({ pendingPolicyKey: temp, model: "iPhone17,1", os: "iOS 26.1 23B85" });

    const second = await post(db, "Provision", provisionRequest(temp), { policyKey: temp });
    const final = childText(
      child(child(second.body, "Provision:Policies"), "Provision:Policy"),
      "Provision:PolicyKey",
    );
    expect(final).toMatch(/^\d+$/);
    expect(final).not.toBe(temp);
    expect(device()?.policyKey).toBe(final);
    expect(device()?.pendingPolicyKey).toBeUndefined();
  });

  it("refuses an acknowledgement with the wrong key", async () => {
    await post(db, "Provision", provisionRequest());
    const res = await post(db, "Provision", provisionRequest("999"));
    expect(
      childText(child(child(res.body, "Provision:Policies"), "Provision:Policy"), "Provision:Status"),
    ).toBe("5");
    expect(device()?.policyKey).toBeUndefined();
  });

  it("acknowledges a remote wipe report without wiping anything", async () => {
    const res = await post(
      db,
      "Provision",
      el("Provision:Provision", [el("Provision:RemoteWipe", [el("Provision:Status", 1)])]),
    );
    expect(childText(res.body, "Provision:Status")).toBe("1");
  });

  it("re-provisions a device that signs in with a different app password", async () => {
    const key = await provisioned();
    const second = "ZZZZ0000YYYY1111XXXX2222";
    db.put(DIR, {
      ...directoryKeys.appPassword(hashAppPassword(second), ALICE, "pw2"),
      type: "app-password",
      id: "pw2",
      userId: ALICE,
      mailboxId: MBX,
      label: "New iPhone",
      createdAt: "2026-11-10T00:00:00.000Z",
    });
    const res = await post(db, "FolderSync", folderSync("0"), { policyKey: key, auth: basic(ALICE, second) });
    expect(childText(res.body, "FolderHierarchy:Status")).toBe("142");
    expect(device()).toMatchObject({ passwordId: "pw2" });
    expect(device()?.policyKey).toBeUndefined();
  });
});

describe("FolderSync", () => {
  it("lists the five system folders, then reports no changes for the current key", async () => {
    const key = await provisioned();
    const first = await post(db, "FolderSync", folderSync("0"), { policyKey: key });
    expect(childText(first.body, "FolderHierarchy:Status")).toBe("1");
    expect(childText(first.body, "FolderHierarchy:SyncKey")).toBe("1");
    const changes = child(first.body, "FolderHierarchy:Changes");
    expect(childText(changes, "FolderHierarchy:Count")).toBe("5");
    expect(
      children(changes, "FolderHierarchy:Add").map((a) => [
        childText(a, "FolderHierarchy:ServerId"),
        childText(a, "FolderHierarchy:DisplayName"),
        childText(a, "FolderHierarchy:Type"),
        childText(a, "FolderHierarchy:ParentId"),
      ]),
    ).toEqual([
      ["inbox", "Inbox", "2", "0"],
      ["sent", "Sent", "5", "0"],
      ["trash", "Trash", "4", "0"],
      ["junk", "Junk", "12", "0"],
      ["archive", "Archive", "12", "0"],
    ]);

    const again = await post(db, "FolderSync", folderSync("1"), { policyKey: key });
    expect(childText(child(again.body, "FolderHierarchy:Changes"), "FolderHierarchy:Count")).toBe("0");

    const unknown = await post(db, "FolderSync", folderSync("7"), { policyKey: key });
    expect(childText(unknown.body, "FolderHierarchy:Status")).toBe("9");
  });
});

describe("Settings", () => {
  it("saves device information and returns the mailbox address", async () => {
    const key = await provisioned();
    const res = await post(
      db,
      "Settings",
      el("Settings:Settings", [
        el("Settings:DeviceInformation", [
          el("Settings:Set", [
            el("Settings:Model", "iPhone18,2"),
            el("Settings:FriendlyName", "Alice's phone"),
          ]),
        ]),
        el("Settings:UserInformation", [el("Settings:Get")]),
        el("Settings:Oof", [el("Settings:Get", [el("Settings:BodyType", "Text")])]),
      ]),
      { policyKey: key },
    );
    expect(childText(res.body, "Settings:Status")).toBe("1");
    expect(device()).toMatchObject({ model: "iPhone18,2", friendlyName: "Alice's phone" });
    const account = child(
      child(child(child(res.body, "Settings:UserInformation"), "Settings:Get"), "Settings:Accounts"),
      "Settings:Account",
    );
    expect(childText(account, "Settings:UserDisplayName")).toBe("Alice");
    expect(childText(child(account, "Settings:EmailAddresses"), "Settings:PrimarySmtpAddress")).toBe(ALICE);
    expect(childText(child(child(res.body, "Settings:Oof"), "Settings:Get"), "Settings:OofState")).toBe("0");
  });

  it("refuses to set out-of-office", async () => {
    const key = await provisioned();
    const res = await post(
      db,
      "Settings",
      el("Settings:Settings", [el("Settings:Oof", [el("Settings:Set", [el("Settings:OofState", 1)])])]),
      { policyKey: key },
    );
    expect(childText(child(res.body, "Settings:Oof"), "Settings:Status")).toBe("7");
  });
});
