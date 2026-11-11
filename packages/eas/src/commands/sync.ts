// Sync ([MS-ASCMD] 2.2.1.21): applies the phone's changes to a folder, then sends what changed
// since its sync key by diffing the stored snapshot against the folder as it is now.
import {
  changeMessage,
  findMessage,
  isSystemFolder,
  type MessageChanges,
  type MessageItem,
  MessageNotFoundError,
  removeMessage,
  type SystemFolder,
} from "@sesame/core";
import { updateDevice } from "../auth.ts";
import { parseServerId, serverId } from "../ids.ts";
import { changeData, chooseBody, emailData } from "../items.ts";
import { folderVersion, listWindow } from "../mailbox.ts";
import type { CommandContext, Handler } from "../protocol.ts";
import {
  DEFAULT_OPTIONS,
  emailOptions,
  type FolderState,
  firstState,
  flagsOf,
  loadState,
  MAX_WINDOW,
  nextKey,
  pack,
  parseOptions,
  type Snapshot,
  StateConflictError,
  type SyncOptions,
  saveState,
  unconfirmed,
  unpack,
  windowStart,
} from "../state.ts";
import { child, children, childText, type Element, el } from "../wbxml/codec.ts";

export const SyncStatus = {
  Success: 1,
  InvalidSyncKey: 3,
  ProtocolError: 4,
  ServerError: 5,
  ConversionError: 6,
  NotFound: 8,
  HierarchyChanged: 12,
  IncompleteRequest: 13,
} as const;

const DEFAULT_WINDOW_SIZE = 100;
const MAX_WINDOW_SIZE = 512;
/** Stop adding items to a response once this many body bytes are in it; MoreAvailable covers the rest. */
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
/** Message bodies read from S3 at once. */
const FETCH_CONCURRENCY = 8;

export interface FolderDiff {
  deletes: string[];
  changes: MessageItem[];
  adds: MessageItem[];
}

/**
 * In the folder but not the snapshot: add. In both with other flags: change. In the snapshot
 * but gone from the folder (moved, deleted, or older than the window): delete. Adds stay newest first.
 */
export function diffFolder(snapshot: Snapshot, items: MessageItem[]): FolderDiff {
  const present = new Set<string>();
  const changes: MessageItem[] = [];
  const adds: MessageItem[] = [];
  for (const m of items) {
    present.add(m.messageUlid);
    const held = snapshot.get(m.messageUlid);
    if (held === undefined) adds.push(m);
    else if (held !== flagsOf(m)) changes.push(m);
  }
  const deletes = [...snapshot.keys()].filter((u) => !present.has(u));
  return { deletes, changes, adds };
}

/**
 * The folder with the phone's own changes from this request laid over it. GSI1 is eventually
 * consistent, so a message the phone just deleted or marked read may still show as it was, and
 * the diff would send the old state straight back. `touched` holds each message's state after
 * the change, or null when it's gone.
 */
function overlay(items: MessageItem[], touched: Map<string, MessageItem | null>, folder: SystemFolder) {
  if (touched.size === 0) return items;
  return items.flatMap((m) => {
    if (!touched.has(m.messageUlid)) return [m];
    const now = touched.get(m.messageUlid);
    return now && now.folder === folder ? [now] : [];
  });
}

export async function folderItems(ctx: CommandContext, folder: SystemFolder, options: SyncOptions) {
  return listWindow(
    ctx.deps,
    ctx.session.mailboxId,
    folder,
    windowStart(options.filterType, ctx.deps.now()),
    MAX_WINDOW,
  );
}

/** One collection of a Sync request, from its element or from the cached last request. */
interface CollectionRequest {
  collectionId: string;
  /** Absent for a collection repeated from the cache: the current key applies. */
  syncKey?: string;
  options: Partial<SyncOptions>;
  getChanges: boolean;
  windowSize: number;
  commands: Element[];
}

function windowSize(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_WINDOW_SIZE) : fallback;
}

function readCollection(c: Element, defaultWindow: number): CollectionRequest {
  const syncKey = childText(c, "AirSync:SyncKey");
  const req: CollectionRequest = {
    collectionId: childText(c, "AirSync:CollectionId") ?? "",
    options: parseOptions(emailOptions(c)),
    // GetChanges defaults to true, except on a first sync (key 0), which never returns items.
    getChanges: childText(c, "AirSync:GetChanges") !== "0",
    windowSize: windowSize(childText(c, "AirSync:WindowSize"), defaultWindow),
    commands: child(c, "AirSync:Commands")?.children ?? [],
  };
  if (syncKey !== undefined) req.syncKey = syncKey;
  return req;
}

/** Changes a phone sends for an item: Read and Flag. */
function clientChanges(data: Element | undefined): MessageChanges {
  const changes: MessageChanges = {};
  const read = childText(data, "Email:Read");
  if (read === "1" || read === "0") changes.read = read === "1";
  const flag = child(data, "Email:Flag");
  // FlagStatus 2 is an active flag; 1 (complete), 0 or an empty Flag clears it.
  if (flag) changes.flagged = childText(flag, "Email:FlagStatus") === "2";
  return changes;
}

function collectionElement(
  key: string,
  collectionId: string,
  status: number,
  extra: (Element | false | undefined)[] = [],
): Element {
  return el("AirSync:Collection", [
    el("AirSync:SyncKey", key),
    el("AirSync:CollectionId", collectionId),
    el("AirSync:Status", status),
    ...extra,
  ]);
}

interface Budget {
  bodyBytes: number;
}

async function syncCollection(ctx: CommandContext, req: CollectionRequest, budget: Budget): Promise<Element> {
  const { deps, session } = ctx;
  const deviceId = session.device.deviceId;
  const key = req.syncKey;
  if (!isSystemFolder(req.collectionId)) {
    return collectionElement(key ?? "0", req.collectionId, SyncStatus.HierarchyChanged);
  }
  const folder = req.collectionId;

  if (key === "0") {
    const state = firstState(deps, session.mailboxId, deviceId, folder, {
      ...DEFAULT_OPTIONS,
      ...req.options,
    });
    await saveState(deps, state);
    return collectionElement(state.key, folder, SyncStatus.Success);
  }

  const state = await loadState(deps, session.mailboxId, deviceId, folder);
  const effectiveKey = key ?? state?.key;
  if (!state || !effectiveKey || (effectiveKey !== state.key && effectiveKey !== state.prevKey)) {
    return collectionElement(key ?? "0", folder, SyncStatus.InvalidSyncKey);
  }
  // A retry of a request whose response the phone never got starts from the previous snapshot.
  const base = unpack(effectiveKey === state.key ? state.snapshot : state.prevSnapshot);
  const options: SyncOptions = { ...state.options, ...req.options };
  const snapshot: Snapshot = new Map(base);
  const responses: Element[] = [];
  const touched = new Map<string, MessageItem | null>();

  for (const command of req.commands) {
    const id = childText(command, "AirSync:ServerId");
    const parsed = parseServerId(id);
    const inFolder = parsed?.folder === folder ? parsed.ulid : undefined;
    switch (command.tag) {
      case "AirSync:Change": {
        if (!inFolder) {
          responses.push(
            el("AirSync:Change", [
              el("AirSync:ServerId", id ?? ""),
              el("AirSync:Status", SyncStatus.NotFound),
            ]),
          );
          break;
        }
        try {
          const m = await changeMessage(
            deps,
            session.mailboxId,
            inFolder,
            clientChanges(child(command, "AirSync:ApplicationData")),
          );
          // A message moved elsewhere meanwhile is a delete in this folder's next diff.
          if (m.folder === folder) snapshot.set(inFolder, flagsOf(m));
          touched.set(inFolder, m);
        } catch (err) {
          if (!(err instanceof MessageNotFoundError)) throw err;
          snapshot.delete(inFolder);
          touched.set(inFolder, null);
          responses.push(
            el("AirSync:Change", [
              el("AirSync:ServerId", id ?? ""),
              el("AirSync:Status", SyncStatus.NotFound),
            ]),
          );
        }
        break;
      }
      case "AirSync:Delete": {
        // Deletes move to Trash, and purge in Trash. Already gone is as good as deleted.
        if (inFolder) {
          await removeMessage(deps, session.mailboxId, inFolder).catch((err) => {
            if (!(err instanceof MessageNotFoundError)) throw err;
          });
          snapshot.delete(inFolder);
          touched.set(inFolder, null);
        }
        break;
      }
      case "AirSync:Add": {
        // Phones can't create mail in these folders (drafts aren't synced).
        const clientId = childText(command, "AirSync:ClientId") ?? "";
        responses.push(
          el("AirSync:Add", [
            el("AirSync:ClientId", clientId),
            el("AirSync:Status", SyncStatus.ConversionError),
          ]),
        );
        break;
      }
      case "AirSync:Fetch": {
        const m = inFolder ? await findMessage(deps, session.mailboxId, inFolder) : undefined;
        if (!m || m.folder !== folder) {
          responses.push(
            el("AirSync:Fetch", [
              el("AirSync:ServerId", id ?? ""),
              el("AirSync:Status", SyncStatus.NotFound),
            ]),
          );
          break;
        }
        const { data, bodyBytes } = await emailData(deps, m, chooseBody(options));
        budget.bodyBytes += bodyBytes;
        responses.push(
          el("AirSync:Fetch", [
            el("AirSync:ServerId", id ?? ""),
            el("AirSync:Status", SyncStatus.Success),
            el("AirSync:ApplicationData", data),
          ]),
        );
        break;
      }
    }
  }

  const commands: Element[] = [];
  let more = false;
  // The version is read after the phone's own changes and before listing, so it covers both:
  // Ping won't wake for what the phone just did, nor miss what lands after this read.
  let seen: { version: number; updatedAt: number; at: number } | undefined;
  if (req.getChanges) {
    seen = { ...(await folderVersion(deps, session.mailboxId, folder)), at: deps.now() };
    const items = overlay(await folderItems(ctx, folder, options), touched, folder);
    const diff = diffFolder(snapshot, items);
    let room = req.windowSize;
    for (const ulid of diff.deletes) {
      if (room === 0) break;
      commands.push(el("AirSync:Delete", [el("AirSync:ServerId", serverId(folder, ulid))]));
      snapshot.delete(ulid);
      room--;
    }
    for (const m of diff.changes) {
      if (room === 0) break;
      commands.push(
        el("AirSync:Change", [
          el("AirSync:ServerId", serverId(folder, m.messageUlid)),
          el("AirSync:ApplicationData", changeData(m)),
        ]),
      );
      snapshot.set(m.messageUlid, flagsOf(m));
      room--;
    }
    const pref = chooseBody(options);
    let added = 0;
    while (room > 0 && added < diff.adds.length && budget.bodyBytes < MAX_RESPONSE_BODY_BYTES) {
      const batch = diff.adds.slice(added, added + Math.min(room, FETCH_CONCURRENCY));
      const built = await Promise.all(batch.map((m) => emailData(deps, m, pref)));
      batch.forEach((m, i) => {
        const b = built[i] as { data: Element[]; bodyBytes: number };
        commands.push(
          el("AirSync:Add", [
            el("AirSync:ServerId", serverId(folder, m.messageUlid)),
            el("AirSync:ApplicationData", b.data),
          ]),
        );
        snapshot.set(m.messageUlid, flagsOf(m));
        budget.bodyBytes += b.bodyBytes;
      });
      added += batch.length;
      room -= batch.length;
    }
    more = commands.length < diff.deletes.length + diff.changes.length + diff.adds.length;
  }

  const optionsChanged = JSON.stringify(options) !== JSON.stringify(state.options);
  const version = seen ? { version: seen.version, versionAt: seen.at } : {};
  // Worth a write on its own when Ping would otherwise keep waking for a version already seen.
  const versionChanged =
    seen !== undefined &&
    (seen.version !== state.version ||
      state.versionAt === undefined ||
      unconfirmed(seen.updatedAt, state.versionAt));
  let responseKey = effectiveKey;
  if (commands.length || req.commands.length) {
    responseKey = nextKey(state.key);
    const next: FolderState = {
      ...state,
      key: responseKey,
      snapshot: pack(snapshot),
      prevKey: effectiveKey,
      prevSnapshot: pack(base),
      options,
      ...version,
    };
    try {
      await saveState(deps, next, state);
    } catch (err) {
      if (!(err instanceof StateConflictError)) throw err;
      // Another request for this folder got there first; the phone starts the folder again.
      deps.log("warn", "ActiveSync sync state changed concurrently", { folder });
      return collectionElement(effectiveKey, folder, SyncStatus.InvalidSyncKey);
    }
  } else if (optionsChanged || versionChanged) {
    await saveState(deps, { ...state, options, ...version }, state).catch((err) => {
      if (!(err instanceof StateConflictError)) throw err;
    });
  }

  return collectionElement(responseKey, folder, SyncStatus.Success, [
    responses.length > 0 && el("AirSync:Responses", responses),
    more && el("AirSync:MoreAvailable"),
    commands.length > 0 && el("AirSync:Commands", commands),
  ]);
}

export const sync: Handler = async (ctx, body) => {
  const device = ctx.session.device;
  const defaultWindow = windowSize(childText(body, "AirSync:WindowSize"), DEFAULT_WINDOW_SIZE);
  const listed = children(child(body, "AirSync:Collections"), "AirSync:Collection").map((c) =>
    readCollection(c, defaultWindow),
  );
  const partial = child(body, "AirSync:Partial") !== undefined;

  // An empty request repeats the last one; a partial one adds the rest of the last one.
  let requests = listed;
  if (!body || partial) {
    const cached = device.syncCollections ?? [];
    if (!body && !cached.length) {
      return el("AirSync:Sync", [el("AirSync:Status", SyncStatus.IncompleteRequest)]);
    }
    const named = new Set(listed.map((r) => r.collectionId));
    requests = [
      ...listed,
      ...cached
        .filter((id) => !named.has(id))
        .map((collectionId) => ({
          collectionId,
          options: {},
          getChanges: true,
          windowSize: defaultWindow,
          commands: [],
        })),
    ];
  }
  if (!requests.length) return el("AirSync:Sync", [el("AirSync:Status", SyncStatus.ProtocolError)]);

  const ids = requests.map((r) => r.collectionId);
  if (body && ids.join(",") !== (device.syncCollections ?? []).join(",")) {
    ctx.session.device = await updateDevice(ctx.deps, device, { syncCollections: ids });
  }

  const budget: Budget = { bodyBytes: 0 };
  const collections: Element[] = [];
  // One at a time, so the body budget is shared fairly in request order.
  for (const r of requests) collections.push(await syncCollection(ctx, r, budget));
  return el("AirSync:Sync", [el("AirSync:Collections", collections)]);
};
