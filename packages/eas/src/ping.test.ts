import { changeMessage, deterministicUlid, directoryKeys, mailKeys } from "@sesame/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { MAX_HEARTBEAT, POLL_MS } from "./commands/ping.ts";
import { type FolderState, INDEX_LAG_MS } from "./state.ts";
import { ALICE, basic, DIR, FakeDb, MAIL, MBX, NOW, PASSWORD, POLICY_KEY, post } from "./testing.ts";
import { child, children, childText, type Element, el } from "./wbxml/codec.ts";

let db: FakeDb;
const MSG = deterministicUlid(NOW - 3_600_000, "m1");

beforeEach(() => {
  db = new FakeDb();
  db.deps.config.push = true;
  db.seedAlice();
  db.seedDevice();
  db.seedMessage(MSG);
});

const pingBody = (heartbeat?: number, folders?: string[]) =>
  el("Ping:Ping", [
    heartbeat !== undefined && el("Ping:HeartbeatInterval", heartbeat),
    folders &&
      el(
        "Ping:Folders",
        folders.map((id) => el("Ping:Folder", [el("Ping:Id", id), el("Ping:Class", "Email")])),
      ),
  ]);

async function ping(body?: Element) {
  const { body: res } = await post(db, "Ping", body, { policyKey: POLICY_KEY });
  return {
    status: childText(res, "Ping:Status"),
    folders: children(child(res, "Ping:Folders"), "Ping:Folder").map((f) => f.text),
    heartbeat: childText(res, "Ping:HeartbeatInterval"),
  };
}

async function sync(key: string, commands?: Element[]) {
  const { body } = await post(
    db,
    "Sync",
    el("AirSync:Sync", [
      el("AirSync:Collections", [
        el("AirSync:Collection", [
          el("AirSync:SyncKey", key),
          el("AirSync:CollectionId", "inbox"),
          commands && el("AirSync:Commands", commands),
        ]),
      ]),
    ]),
    { policyKey: POLICY_KEY },
  );
  return childText(child(child(body, "AirSync:Collections"), "AirSync:Collection"), "AirSync:SyncKey") ?? "";
}

/** Brings the inbox up to date, as a phone does before it starts pinging. */
async function primed() {
  return sync(await sync("0"));
}

/** What ingest does when mail arrives: bumps the folder counter's version. */
function arrive(at: number) {
  const key = mailKeys.folderCounter(MBX, "inbox");
  const cur = db.get(MAIL, key);
  db.put(MAIL, {
    ...key,
    total: 1,
    version: Number(cur?.version ?? 0) + 1,
    updatedAt: new Date(at).toISOString(),
  });
}

describe("Ping", () => {
  it("is advertised only when push is on", async () => {
    const options = async () => {
      const r = await createApp(async () => db.deps).request("/Microsoft-Server-ActiveSync", {
        method: "OPTIONS",
        headers: { Authorization: basic(ALICE, PASSWORD) },
      });
      return r.headers.get("MS-ASProtocolCommands") ?? "";
    };
    expect((await options()).split(",")).toContain("Ping");
    db.deps.config.push = false;
    expect((await options()).split(",")).not.toContain("Ping");
  });

  it("answers 1 when the heartbeat ends with nothing new, polling every 20 seconds", async () => {
    await primed();
    const sleeps: number[] = [];
    db.onSleep = (clock) => sleeps.push(clock - NOW);
    expect(await ping(pingBody(60, ["inbox"]))).toMatchObject({ status: "1", folders: [] });
    expect(sleeps).toEqual([POLL_MS, 2 * POLL_MS, 3 * POLL_MS]);
  });

  it("answers 2 with the folder as soon as mail arrives", async () => {
    await primed();
    db.onSleep = (clock) => {
      if (clock === NOW + 2 * POLL_MS) arrive(clock);
    };
    expect(await ping(pingBody(480, ["inbox"]))).toEqual({
      status: "2",
      folders: ["inbox"],
      heartbeat: undefined,
    });
    expect(db.clock).toBe(NOW + 2 * POLL_MS);
  });

  it("doesn't miss mail that arrived between the Sync and the Ping", async () => {
    await primed();
    arrive(NOW);
    db.clock = NOW + 10 * 60_000;
    expect(await ping(pingBody(480, ["inbox"]))).toMatchObject({ status: "2", folders: ["inbox"] });
  });

  it("wakes for a flag set elsewhere, which changes no counts", async () => {
    await primed();
    db.clock = NOW + 60_000;
    db.onSleep = (clock) => {
      if (clock === NOW + 60_000 + POLL_MS) void changeMessage(db.deps, MBX, MSG, { flagged: true });
    };
    expect(await ping(pingBody(480, ["inbox"]))).toMatchObject({ status: "2", folders: ["inbox"] });
  });

  it("after the phone's own change, wakes once when the index has caught up, then waits", async () => {
    const key = await primed();
    db.clock = NOW + 60_000;
    // Marking read bumps the version; the Sync that did it records the new version.
    await sync(key, [
      el("AirSync:Change", [
        el("AirSync:ServerId", `inbox:${MSG}`),
        el("AirSync:ApplicationData", [el("Email:Read", 1)]),
      ]),
    ]);
    const first = await ping(pingBody(480, ["inbox"]));
    expect(first.status).toBe("2");
    expect(db.clock).toBe(NOW + 60_000 + INDEX_LAG_MS);

    // The follow-up Sync finds nothing but confirms the version, so the next Ping waits it out.
    const state = db.get(MAIL, mailKeys.easState(MBX, "ABC123", "inbox")) as unknown as FolderState;
    await sync(state.key);
    expect((await ping(pingBody(480, ["inbox"]))).status).toBe("1");
  });

  it("wakes at once for a folder the phone never synced", async () => {
    await primed();
    expect(await ping(pingBody(480, ["inbox", "trash"]))).toMatchObject({ status: "2", folders: ["trash"] });
    expect(db.clock).toBe(NOW);
  });

  it("repeats the last heartbeat and folders for an empty Ping, and asks for them when there are none", async () => {
    await primed();
    expect((await ping()).status).toBe("3");
    expect((await ping(pingBody(undefined, ["inbox"]))).status).toBe("3");

    await ping(pingBody(120, ["inbox"]));
    const device = db.get(DIR, directoryKeys.device(ALICE, "ABC123"));
    expect(device).toMatchObject({ pingHeartbeat: 120, pingFolders: ["inbox"] });

    arrive(db.clock);
    expect(await ping()).toMatchObject({ status: "2", folders: ["inbox"] });
  });

  it("answers 5 with the limit for a heartbeat out of range", async () => {
    expect(await ping(pingBody(900, ["inbox"]))).toMatchObject({
      status: "5",
      heartbeat: String(MAX_HEARTBEAT),
    });
    expect(await ping(pingBody(30, ["inbox"]))).toMatchObject({ status: "5", heartbeat: "60" });
  });

  it("answers 7 for a folder it doesn't know", async () => {
    expect((await ping(pingBody(480, ["inbox", "Calendar"]))).status).toBe("7");
  });
});
