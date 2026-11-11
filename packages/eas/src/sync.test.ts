import { type DeviceItem, deterministicUlid, directoryKeys, mailKeys } from "@sesame/core";
import { beforeEach, describe, expect, it } from "vitest";
import { parseServerId } from "./ids.ts";
import { type FolderState, unpack } from "./state.ts";
import { ALICE, DIR, FakeDb, MAIL, MBX, NOW, POLICY_KEY, post } from "./testing.ts";
import { child, children, childText, type Element, el } from "./wbxml/codec.ts";

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  db.seedAlice();
  db.seedDevice();
});

const HOUR = 3_600_000;
/** A message id received `hoursAgo` hours before NOW. */
const ulid = (hoursAgo: number, seed = String(hoursAgo)) => deterministicUlid(NOW - hoursAgo * HOUR, seed);
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

interface CollectionSpec {
  id: string;
  key: string;
  window?: number;
  options?: Element[];
  commands?: Element[];
  getChanges?: boolean;
}

const syncBody = (collections: CollectionSpec[], extra: Element[] = []) =>
  el("AirSync:Sync", [
    el(
      "AirSync:Collections",
      collections.map((c) =>
        el("AirSync:Collection", [
          el("AirSync:SyncKey", c.key),
          el("AirSync:CollectionId", c.id),
          c.getChanges === false && el("AirSync:GetChanges", "0"),
          c.window !== undefined && el("AirSync:WindowSize", c.window),
          c.options && el("AirSync:Options", c.options),
          c.commands && el("AirSync:Commands", c.commands),
        ]),
      ),
    ),
    ...extra,
  ]);

const mimeOptions = (truncation?: number, filterType = 0) => [
  el("AirSync:FilterType", filterType),
  el("AirSync:MIMESupport", 2),
  el("AirSyncBase:BodyPreference", [
    el("AirSyncBase:Type", 4),
    truncation !== undefined && el("AirSyncBase:TruncationSize", truncation),
  ]),
];

async function sync(collections: CollectionSpec[], extra?: Element[]) {
  const { res, body } = await post(db, "Sync", syncBody(collections, extra), { policyKey: POLICY_KEY });
  expect(res.status).toBe(200);
  return body;
}

function collection(body: Element | undefined, id = "inbox") {
  const c = children(child(body, "AirSync:Collections"), "AirSync:Collection").find(
    (x) => childText(x, "AirSync:CollectionId") === id,
  );
  const commands = child(c, "AirSync:Commands")?.children ?? [];
  return {
    key: childText(c, "AirSync:SyncKey") ?? "",
    status: childText(c, "AirSync:Status"),
    more: child(c, "AirSync:MoreAvailable") !== undefined,
    responses: child(c, "AirSync:Responses")?.children ?? [],
    commands,
    adds: commands.filter((x) => x.tag === "AirSync:Add"),
    changes: commands.filter((x) => x.tag === "AirSync:Change"),
    deletes: commands.filter((x) => x.tag === "AirSync:Delete"),
  };
}

const ids = (commands: Element[]) => commands.map((c) => childText(c, "AirSync:ServerId"));
const data = (command: Element | undefined) => child(command, "AirSync:ApplicationData");

/** Primes the inbox (key 0) and runs the first full sync, returning the key after it. */
async function primed(options = mimeOptions()): Promise<string> {
  const first = collection(await sync([{ id: "inbox", key: "0", options }]));
  const second = collection(await sync([{ id: "inbox", key: first.key }]));
  expect(second.more).toBe(false);
  return second.key;
}

const state = (folder = "inbox") =>
  db.get(MAIL, mailKeys.easState(MBX, "ABC123", folder)) as FolderState | undefined;

describe("Sync", () => {
  it("answers a first sync with a new key and no items", async () => {
    db.seedMessage(ulid(1));
    const c = collection(await sync([{ id: "inbox", key: "0", options: mimeOptions() }]));
    expect(c.status).toBe("1");
    expect(c.key).toMatch(/^[0-9a-f]{8}:1$/);
    expect(c.commands).toEqual([]);
    expect(state()?.options).toMatchObject({ filterType: 0, mimeSupport: 2 });
  });

  it("sends the folder newest first with MIME bodies, a window at a time", async () => {
    const [a, b, c] = [ulid(3), ulid(2), ulid(1)];
    db.seedMessage(a);
    db.seedMessage(b, { read: true });
    db.seedMessage(c, { flagged: true, cc: [{ name: 'Carol "C"', address: "carol@example.org" }] });
    const first = collection(await sync([{ id: "inbox", key: "0", options: mimeOptions() }]));

    const page1 = collection(await sync([{ id: "inbox", key: first.key, window: 2 }]));
    expect(ids(page1.adds)).toEqual([`inbox:${c}`, `inbox:${b}`]);
    expect(page1.more).toBe(true);
    expect(page1.key).not.toBe(first.key);

    const newest = data(page1.adds[0]);
    expect(childText(newest, "Email:From")).toBe('"Bob" <bob@example.net>');
    expect(childText(newest, "Email:Cc")).toBe('"Carol \\"C\\"" <carol@example.org>');
    expect(childText(newest, "Email:Read")).toBe("0");
    expect(childText(child(newest, "Email:Flag"), "Email:FlagStatus")).toBe("2");
    const body = child(newest, "AirSyncBase:Body");
    expect(childText(body, "AirSyncBase:Type")).toBe("4");
    expect(childText(body, "AirSyncBase:Data")).toContain(`Subject: Hello ${c}`);
    expect(child(body, "AirSyncBase:Truncated")).toBeUndefined();
    expect(childText(data(page1.adds[1]), "Email:Read")).toBe("1");

    const page2 = collection(await sync([{ id: "inbox", key: page1.key, window: 2 }]));
    expect(ids(page2.adds)).toEqual([`inbox:${a}`]);
    expect(page2.more).toBe(false);

    const nothing = collection(await sync([{ id: "inbox", key: page2.key }]));
    expect(nothing.commands).toEqual([]);
    expect(nothing.key).toBe(page2.key);
  });

  it("truncates MIME at the size asked for and remembers the options", async () => {
    const m = db.seedMessage(ulid(1));
    const first = collection(await sync([{ id: "inbox", key: "0", options: mimeOptions(20) }]));
    const c = collection(await sync([{ id: "inbox", key: first.key }]));
    const body = child(data(c.adds[0]), "AirSyncBase:Body");
    expect(childText(body, "AirSyncBase:Truncated")).toBe("1");
    expect(childText(body, "AirSyncBase:Data")).toHaveLength(20);
    expect(childText(body, "AirSyncBase:EstimatedDataSize")).toBe(String(m.size));
  });

  it("only sends messages inside the filter window", async () => {
    const recent = ulid(2);
    db.seedMessage(recent, { receivedAt: at(2) });
    db.seedMessage(ulid(48), { receivedAt: at(48) });
    const first = collection(await sync([{ id: "inbox", key: "0", options: mimeOptions(undefined, 1) }]));
    const c = collection(await sync([{ id: "inbox", key: first.key }]));
    expect(ids(c.adds)).toEqual([`inbox:${recent}`]);
  });

  it("sends changes, deletes and new mail made elsewhere", async () => {
    const [a, b] = [ulid(3), ulid(2)];
    db.seedMessage(a);
    db.seedMessage(b);
    const key = await primed();

    db.put(MAIL, { ...db.message(a), read: true });
    db.delete(MAIL, mailKeys.message(MBX, b));
    const fresh = ulid(0.5);
    db.seedMessage(fresh);

    const c = collection(await sync([{ id: "inbox", key }]));
    expect(ids(c.deletes)).toEqual([`inbox:${b}`]);
    expect(ids(c.changes)).toEqual([`inbox:${a}`]);
    expect(childText(data(c.changes[0]), "Email:Read")).toBe("1");
    expect(child(data(c.changes[0]), "Email:Subject")).toBeUndefined();
    expect(ids(c.adds)).toEqual([`inbox:${fresh}`]);
  });

  it("answers a retried request the same way, and rejects unknown keys", async () => {
    db.seedMessage(ulid(1));
    const first = collection(await sync([{ id: "inbox", key: "0", options: mimeOptions() }]));
    const once = collection(await sync([{ id: "inbox", key: first.key }]));
    const again = collection(await sync([{ id: "inbox", key: first.key }]));
    expect(ids(again.adds)).toEqual(ids(once.adds));
    expect(again.status).toBe("1");

    const stale = collection(await sync([{ id: "inbox", key: "deadbeef:7" }]));
    expect(stale.status).toBe("3");
    expect(stale.commands).toEqual([]);
  });

  it("applies read, flag and delete from the phone without echoing them back", async () => {
    const [a, b] = [ulid(3), ulid(2)];
    db.seedMessage(a);
    db.seedMessage(b);
    const key = await primed();

    const c = collection(
      await sync([
        {
          id: "inbox",
          key,
          commands: [
            el("AirSync:Change", [
              el("AirSync:ServerId", `inbox:${a}`),
              el("AirSync:ApplicationData", [
                el("Email:Read", "1"),
                el("Email:Flag", [el("Email:FlagStatus", "2"), el("Email:FlagType", "for Follow Up")]),
              ]),
            ]),
            el("AirSync:Delete", [el("AirSync:ServerId", `inbox:${b}`)]),
          ],
        },
      ]),
    );
    expect(c.status).toBe("1");
    expect(c.commands).toEqual([]);
    expect(c.responses).toEqual([]);
    expect(db.message(a)).toMatchObject({ read: true, flagged: true });
    expect(db.message(b)?.folder).toBe("trash");
    expect(db.get(MAIL, mailKeys.folderCounter(MBX, "inbox"))).toMatchObject({ total: -1, unread: -2 });

    // Nothing comes back on the next sync either.
    expect(collection(await sync([{ id: "inbox", key: c.key }])).commands).toEqual([]);
  });

  it("reports changes to missing messages and refuses adds", async () => {
    const key = await primed();
    const c = collection(
      await sync([
        {
          id: "inbox",
          key,
          commands: [
            el("AirSync:Change", [
              el("AirSync:ServerId", `inbox:${ulid(5)}`),
              el("AirSync:ApplicationData", [el("Email:Read", "1")]),
            ]),
            el("AirSync:Add", [el("AirSync:ClientId", "c1"), el("AirSync:ApplicationData", [])]),
          ],
        },
      ]),
    );
    expect(c.responses.map((r) => [r.tag, childText(r, "AirSync:Status")])).toEqual([
      ["AirSync:Change", "8"],
      ["AirSync:Add", "6"],
    ]);
  });

  it("fetches one message on request", async () => {
    const m = ulid(1);
    db.seedMessage(m);
    const key = await primed();
    const c = collection(
      await sync([
        {
          id: "inbox",
          key,
          getChanges: false,
          commands: [el("AirSync:Fetch", [el("AirSync:ServerId", `inbox:${m}`)])],
        },
      ]),
    );
    const fetch = c.responses[0];
    expect(childText(fetch, "AirSync:Status")).toBe("1");
    expect(childText(child(data(fetch), "AirSyncBase:Body"), "AirSyncBase:Data")).toContain("Hi Alice.");
  });

  it("repeats the last request when the body is empty", async () => {
    db.seedMessage(ulid(1));
    const first = collection(await sync([{ id: "inbox", key: "0", options: mimeOptions() }]));
    expect(
      (db.get(DIR, directoryKeys.device(ALICE, "ABC123")) as unknown as DeviceItem).syncCollections,
    ).toEqual(["inbox"]);

    const { body } = await post(db, "Sync", undefined, { policyKey: POLICY_KEY });
    const c = collection(body);
    expect(c.adds).toHaveLength(1);
    expect(c.key).not.toBe(first.key);
  });

  it("asks for a full request when there's nothing to repeat", async () => {
    const { body } = await post(db, "Sync", undefined, { policyKey: POLICY_KEY });
    expect(childText(body, "AirSync:Status")).toBe("13");
  });

  it("answers unknown folders with status 12", async () => {
    expect(collection(await sync([{ id: "drafts", key: "0" }]), "drafts").status).toBe("12");
  });

  it("syncs several folders in one request", async () => {
    db.seedMessage(ulid(1));
    db.seedMessage(ulid(2), { folder: "sent" });
    const first = await sync([
      { id: "inbox", key: "0", options: mimeOptions() },
      { id: "sent", key: "0", options: mimeOptions() },
    ]);
    const second = await sync([
      { id: "inbox", key: collection(first, "inbox").key },
      { id: "sent", key: collection(first, "sent").key },
    ]);
    expect(collection(second, "inbox").adds).toHaveLength(1);
    expect(collection(second, "sent").adds).toHaveLength(1);
  });

  it("keeps a snapshot of what the phone holds", async () => {
    const [a, b] = [ulid(3), ulid(2)];
    db.seedMessage(a, { read: true });
    db.seedMessage(b, { flagged: true });
    await primed();
    expect([...unpack(state()?.snapshot)].sort()).toEqual(
      [
        [a, 1],
        [b, 2],
      ].sort(),
    );
  });
});

describe("GetItemEstimate", () => {
  const estimate = async (key: string, id = "inbox") => {
    const { body } = await post(
      db,
      "GetItemEstimate",
      el("GetItemEstimate:GetItemEstimate", [
        el("GetItemEstimate:Collections", [
          el("GetItemEstimate:Collection", [
            el("AirSync:SyncKey", key),
            el("GetItemEstimate:CollectionId", id),
          ]),
        ]),
      ]),
      { policyKey: POLICY_KEY },
    );
    const response = child(body, "GetItemEstimate:Response");
    return {
      status: childText(response, "GetItemEstimate:Status"),
      estimate: childText(child(response, "GetItemEstimate:Collection"), "GetItemEstimate:Estimate"),
    };
  };

  it("counts what the next sync would send", async () => {
    db.seedMessage(ulid(3));
    const key = await primed();
    expect(await estimate(key)).toEqual({ status: "1", estimate: "0" });
    db.seedMessage(ulid(1));
    db.seedMessage(ulid(2));
    expect(await estimate(key)).toEqual({ status: "1", estimate: "2" });
  });

  it("rejects unprimed, unknown and stale collections", async () => {
    expect((await estimate("0")).status).toBe("3");
    expect((await estimate("1", "drafts")).status).toBe("2");
    expect((await estimate("deadbeef:1")).status).toBe("4");
  });
});

describe("MoveItems", () => {
  const move = async (src: string, srcFolder: string, dst: string) => {
    const { body } = await post(
      db,
      "MoveItems",
      el("Move:MoveItems", [
        el("Move:Move", [el("Move:SrcMsgId", src), el("Move:SrcFldId", srcFolder), el("Move:DstFldId", dst)]),
      ]),
      { policyKey: POLICY_KEY },
    );
    const r = child(body, "Move:Response");
    return { status: childText(r, "Move:Status"), dst: childText(r, "Move:DstMsgId") };
  };

  it("moves the message and keeps both folders' snapshots in step", async () => {
    const m = ulid(1);
    db.seedMessage(m);
    const inboxKey = await primed();
    const archive0 = collection(await sync([{ id: "archive", key: "0", options: mimeOptions() }]), "archive");
    const archiveKey = collection(await sync([{ id: "archive", key: archive0.key }]), "archive").key;

    expect(await move(`inbox:${m}`, "inbox", "archive")).toEqual({ status: "3", dst: `archive:${m}` });
    expect(db.message(m)?.folder).toBe("archive");
    expect(parseServerId(`archive:${m}`)).toEqual({ folder: "archive", ulid: m });

    const after = await sync([
      { id: "inbox", key: inboxKey },
      { id: "archive", key: archiveKey },
    ]);
    expect(collection(after, "inbox").commands).toEqual([]);
    expect(collection(after, "archive").commands).toEqual([]);
  });

  it("refuses bad sources, bad destinations and same-folder moves", async () => {
    const m = ulid(1);
    db.seedMessage(m);
    expect((await move(`inbox:${ulid(9)}`, "inbox", "archive")).status).toBe("1");
    expect((await move(`inbox:${m}`, "sent", "archive")).status).toBe("1");
    expect((await move(`inbox:${m}`, "inbox", "drafts")).status).toBe("2");
    expect((await move(`inbox:${m}`, "inbox", "inbox")).status).toBe("4");
  });
});

describe("ItemOperations", () => {
  const fetchOp = (children_: Element[]) =>
    el("ItemOperations:ItemOperations", [
      el("ItemOperations:Fetch", [el("ItemOperations:Store", "Mailbox"), ...children_]),
    ]);
  const fetchResult = (body: Element | undefined) =>
    child(child(body, "ItemOperations:Response"), "ItemOperations:Fetch");

  it("fetches a whole message as MIME", async () => {
    const m = ulid(1);
    const item = db.seedMessage(m, { mime: `Subject: Big\r\n\r\n${"x".repeat(5000)}` });
    const { body } = await post(
      db,
      "ItemOperations",
      fetchOp([
        el("AirSync:CollectionId", "inbox"),
        el("AirSync:ServerId", `inbox:${m}`),
        el("ItemOperations:Options", [
          el("AirSync:MIMESupport", 2),
          el("AirSyncBase:BodyPreference", [el("AirSyncBase:Type", 4)]),
        ]),
      ]),
      { policyKey: POLICY_KEY },
    );
    const f = fetchResult(body);
    expect(childText(f, "ItemOperations:Status")).toBe("1");
    expect(childText(f, "AirSync:Class")).toBe("Email");
    const data_ = childText(
      child(child(f, "ItemOperations:Properties"), "AirSyncBase:Body"),
      "AirSyncBase:Data",
    );
    expect(data_).toHaveLength(item.size);
  });

  it("fetches an attachment as base64, or a range of it", async () => {
    const m = ulid(1);
    db.seedMessage(m, {
      hasAttachments: true,
      attachments: [
        { partId: "1", filename: "a.pdf", contentType: "application/pdf", size: 300, inline: false },
      ],
    });
    const { body } = await post(db, "ItemOperations", fetchOp([el("AirSyncBase:FileReference", `${m}:1`)]), {
      policyKey: POLICY_KEY,
    });
    const props = child(fetchResult(body), "ItemOperations:Properties");
    expect(childText(props, "AirSyncBase:ContentType")).toBe("application/pdf");
    expect(Buffer.from(childText(props, "ItemOperations:Data") ?? "", "base64")).toEqual(
      Buffer.alloc(300, 0x61),
    );

    const ranged = await post(
      db,
      "ItemOperations",
      fetchOp([
        el("AirSyncBase:FileReference", `${m}:1`),
        el("ItemOperations:Options", [el("ItemOperations:Range", "0-99")]),
      ]),
      { policyKey: POLICY_KEY },
    );
    const rp = child(fetchResult(ranged.body), "ItemOperations:Properties");
    expect(childText(rp, "ItemOperations:Range")).toBe("0-99");
    expect(childText(rp, "ItemOperations:Total")).toBe("300");
    expect(Buffer.from(childText(rp, "ItemOperations:Data") ?? "", "base64")).toHaveLength(100);
  });

  it("sends attachments as parts to phones that accept multipart", async () => {
    const m = ulid(1);
    db.seedMessage(m, {
      attachments: [{ partId: "1", filename: "a.txt", contentType: "text/plain", size: 10, inline: false }],
    });
    const { res, bytes } = await post(
      db,
      "ItemOperations",
      fetchOp([el("AirSyncBase:FileReference", `${m}:1`)]),
      {
        policyKey: POLICY_KEY,
        headers: { "MS-ASAcceptMultiPart": "T" },
      },
    );
    expect(res.headers.get("content-type")).toBe("application/vnd.ms-sync.multipart");
    expect(bytes.readInt32LE(0)).toBe(2);
    const [offset, length] = [bytes.readInt32LE(12), bytes.readInt32LE(16)];
    expect(bytes.subarray(offset, offset + length)).toEqual(Buffer.alloc(10, 0x61));
  });

  it("answers missing messages and attachments", async () => {
    const { body } = await post(
      db,
      "ItemOperations",
      fetchOp([el("AirSyncBase:FileReference", `${ulid(1)}:9`)]),
      {
        policyKey: POLICY_KEY,
      },
    );
    expect(childText(fetchResult(body), "ItemOperations:Status")).toBe("15");
    const other = await post(
      db,
      "ItemOperations",
      fetchOp([el("AirSync:CollectionId", "inbox"), el("AirSync:ServerId", `inbox:${ulid(1)}`)]),
      { policyKey: POLICY_KEY },
    );
    expect(childText(fetchResult(other.body), "ItemOperations:Status")).toBe("6");
  });

  it("empties Trash, and only Trash", async () => {
    const [a, b] = [ulid(1), ulid(2)];
    const item = db.seedMessage(a, { folder: "trash" });
    db.seedMessage(b, { folder: "inbox" });
    const empty = (folder: string) =>
      post(
        db,
        "ItemOperations",
        el("ItemOperations:ItemOperations", [
          el("ItemOperations:EmptyFolderContents", [el("AirSync:CollectionId", folder)]),
        ]),
        { policyKey: POLICY_KEY },
      );
    const status = (body: Element | undefined) =>
      childText(
        child(child(body, "ItemOperations:Response"), "ItemOperations:EmptyFolderContents"),
        "ItemOperations:Status",
      );

    expect(status((await empty("trash")).body)).toBe("1");
    expect(db.message(a)).toBeUndefined();
    expect([...db.objects.keys()].some((k) => k.startsWith(item.objectPrefix))).toBe(false);
    expect(status((await empty("inbox")).body)).toBe("2");
    expect(db.message(b)).toBeDefined();
  });
});
