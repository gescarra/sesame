// Per device and folder sync state: the sync key and a snapshot of what the phone holds after it,
// plus the previous key and snapshot so a retried request gets a consistent answer.
// Each Sync diffs the snapshot against the folder as it is now (see the design's "Sync state model").
import { randomBytes } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mailKeys, type SystemFolder } from "@sesame/core";
import type { Deps } from "./deps.ts";
import { bytesToUlid, ulidToBytes } from "./ids.ts";
import { children, childText, type Element } from "./wbxml/codec.ts";

/**
 * The most messages a folder window holds. Two snapshots of 17 bytes a message must fit in one
 * 400 KB item; "all messages" on a larger folder syncs the newest ones.
 */
export const MAX_WINDOW = 10_000;

const ENTRY = 17;
export const READ = 1;
export const FLAGGED = 2;

/** ulid -> READ | FLAGGED bits, as the phone holds it. */
export type Snapshot = Map<string, number>;

export function flagsOf(m: { read: boolean; flagged: boolean }): number {
  return (m.read ? READ : 0) | (m.flagged ? FLAGGED : 0);
}

export function pack(snapshot: Snapshot): Uint8Array {
  const out = Buffer.alloc(snapshot.size * ENTRY);
  let i = 0;
  for (const [ulid, flags] of [...snapshot].sort(([a], [b]) => (a < b ? -1 : 1))) {
    ulidToBytes(ulid).copy(out, i);
    out[i + 16] = flags;
    i += ENTRY;
  }
  return new Uint8Array(out);
}

export function unpack(bytes: Uint8Array | undefined): Snapshot {
  const snapshot: Snapshot = new Map();
  if (!bytes) return snapshot;
  for (let i = 0; i + ENTRY <= bytes.length; i += ENTRY) {
    snapshot.set(bytesToUlid(bytes.subarray(i, i + 16)), bytes[i + 16] as number);
  }
  return snapshot;
}

// --- Options ----------------------------------------------------------------

export interface BodyPreference {
  /** 1 plain text, 2 HTML, 4 MIME */
  type: number;
  truncationSize?: number;
  allOrNone?: boolean;
  /** Characters of preview text wanted beside the body. */
  preview?: number;
}

/** The phone sends Options when they change; the server keeps them between requests. */
export interface SyncOptions {
  /** 0 all, 1 one day, 2 three days, 3 one week, 4 two weeks, 5 one month. */
  filterType: number;
  bodyPreferences: BodyPreference[];
  /** 0 never MIME, 1 S/MIME only, 2 always when asked for. */
  mimeSupport: number;
}

export const DEFAULT_OPTIONS: SyncOptions = {
  filterType: 3,
  bodyPreferences: [{ type: 1, truncationSize: 32 * 1024 }],
  mimeSupport: 0,
};

const FILTER_DAYS: Record<number, number> = { 1: 1, 2: 3, 3: 7, 4: 14, 5: 31, 6: 92, 7: 183 };

/** Receive time the window starts at, or undefined for all messages. */
export function windowStart(filterType: number, now: number): number | undefined {
  const days = FILTER_DAYS[filterType];
  return days === undefined ? undefined : now - days * 86_400_000;
}

function int(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,10}$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/** Reads body preferences under any parent: Sync Options, ItemOperations Options. */
export function parseBodyPreferences(parent: Element | undefined): BodyPreference[] {
  return children(parent, "AirSyncBase:BodyPreference").flatMap((p) => {
    const type = int(childText(p, "AirSyncBase:Type"));
    if (type === undefined) return [];
    const pref: BodyPreference = { type };
    const truncationSize = int(childText(p, "AirSyncBase:TruncationSize"));
    if (truncationSize !== undefined) pref.truncationSize = truncationSize;
    if (childText(p, "AirSyncBase:AllOrNone") === "1") pref.allOrNone = true;
    const preview = int(childText(p, "AirSyncBase:Preview"));
    if (preview) pref.preview = Math.min(preview, 255);
    return [pref];
  });
}

/** The options a request states; what it leaves out keeps its stored value. */
export function parseOptions(options: Element | undefined): Partial<SyncOptions> {
  if (!options) return {};
  const out: Partial<SyncOptions> = {};
  const filterType = int(childText(options, "AirSync:FilterType"));
  if (filterType !== undefined) out.filterType = filterType;
  const prefs = parseBodyPreferences(options);
  if (prefs.length) out.bodyPreferences = prefs;
  const mimeSupport = int(childText(options, "AirSync:MIMESupport"));
  if (mimeSupport !== undefined) out.mimeSupport = mimeSupport;
  return out;
}

/** The Options element of the collection that holds the folder's mail (Class Email or none). */
export function emailOptions(collection: Element | undefined): Element | undefined {
  const all = children(collection, "AirSync:Options");
  return all.find((o) => (childText(o, "AirSync:Class") ?? "Email") === "Email") ?? all[0];
}

// --- Storage ----------------------------------------------------------------

export interface FolderState {
  pk: string;
  sk: string;
  type: "eas-state";
  deviceId: string;
  folder: SystemFolder;
  /** "<pairing>:<n>": the pairing is random per first sync, so keys from lost state never match. */
  key: string;
  snapshot: Uint8Array;
  prevKey?: string;
  prevSnapshot?: Uint8Array;
  options: SyncOptions;
  /**
   * The folder counter's version when the last Sync read it, and when that was (ms). Ping
   * answers once the version moves past it. Absent until a Sync has read it.
   */
  version?: number;
  versionAt?: number;
  /** Bumped on every write; writes are conditional on the revision they read. */
  rev: number;
  updatedAt: string;
}

/**
 * How long a change may take to reach GSI1 after its transaction. A Sync that read a version
 * this soon after it changed may have listed the folder without that change, so Ping treats
 * the stored version as unconfirmed until this has passed.
 */
export const INDEX_LAG_MS = 3000;

/** Whether a version read at `versionAt` may not cover the change made at `updatedAt`. */
export const unconfirmed = (updatedAt: number, versionAt: number) => updatedAt > versionAt - INDEX_LAG_MS;

export class StateConflictError extends Error {}

export async function loadState(
  deps: Deps,
  mailboxId: string,
  deviceId: string,
  folder: SystemFolder,
): Promise<FolderState | undefined> {
  const res = await deps.doc.send(
    new GetCommand({
      TableName: deps.config.mailTable,
      Key: mailKeys.easState(mailboxId, deviceId, folder),
      ConsistentRead: true,
    }),
  );
  return res.Item as FolderState | undefined;
}

/** Just what Ping compares, without the snapshots, which can run to hundreds of kilobytes. */
export async function loadVersion(
  deps: Deps,
  mailboxId: string,
  deviceId: string,
  folder: SystemFolder,
): Promise<Pick<FolderState, "version" | "versionAt"> | undefined> {
  const res = await deps.doc.send(
    new GetCommand({
      TableName: deps.config.mailTable,
      Key: mailKeys.easState(mailboxId, deviceId, folder),
      ProjectionExpression: "pk, #version, versionAt",
      ExpressionAttributeNames: { "#version": "version" },
    }),
  );
  if (!res.Item) return undefined;
  const out: Pick<FolderState, "version" | "versionAt"> = {};
  if (typeof res.Item.version === "number") out.version = res.Item.version;
  if (typeof res.Item.versionAt === "number") out.versionAt = res.Item.versionAt;
  return out;
}

export function firstState(
  deps: Deps,
  mailboxId: string,
  deviceId: string,
  folder: SystemFolder,
  options: SyncOptions,
): FolderState {
  return {
    ...mailKeys.easState(mailboxId, deviceId, folder),
    type: "eas-state",
    deviceId,
    folder,
    key: `${randomBytes(4).toString("hex")}:1`,
    snapshot: new Uint8Array(0),
    options,
    rev: 0,
    updatedAt: new Date(deps.now()).toISOString(),
  };
}

export function nextKey(key: string): string {
  const [pairing, n] = key.split(":");
  return `${pairing}:${Number(n) + 1}`;
}

/**
 * Writes the state. `read` is the state it was computed from: if another request wrote
 * meanwhile, StateConflictError. Without one (a first sync) it replaces whatever was there.
 */
export async function saveState(deps: Deps, state: FolderState, read?: FolderState): Promise<void> {
  const item: FolderState = {
    ...state,
    rev: read ? read.rev + 1 : 0,
    updatedAt: new Date(deps.now()).toISOString(),
  };
  try {
    await deps.doc.send(
      new PutCommand({
        TableName: deps.config.mailTable,
        Item: item,
        ...(read
          ? {
              ConditionExpression: "#rev = :rev",
              ExpressionAttributeNames: { "#rev": "rev" },
              ExpressionAttributeValues: { ":rev": read.rev },
            }
          : {}),
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) throw new StateConflictError();
    throw err;
  }
}

/**
 * Edits both snapshots of a folder's state without moving its key, so a change the phone made
 * through another command (MoveItems) isn't echoed back. Best effort: no state, nothing to do.
 */
export async function editSnapshots(
  deps: Deps,
  mailboxId: string,
  deviceId: string,
  folder: SystemFolder,
  edit: (snapshot: Snapshot) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await loadState(deps, mailboxId, deviceId, folder);
    if (!state) return;
    const current = unpack(state.snapshot);
    edit(current);
    const next: FolderState = { ...state, snapshot: pack(current) };
    if (state.prevSnapshot) {
      const prev = unpack(state.prevSnapshot);
      edit(prev);
      next.prevSnapshot = pack(prev);
    }
    try {
      await saveState(deps, next, state);
      return;
    } catch (err) {
      if (!(err instanceof StateConflictError)) throw err;
    }
  }
}
