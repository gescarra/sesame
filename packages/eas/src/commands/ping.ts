// Ping ([MS-ASCMD] 2.2.1.13): push as a long poll. The phone holds the request open; the server
// answers as soon as a watched folder changes, or with "nothing new" when the heartbeat ends.
// Nothing can reach the one environment holding a given phone's request, so instead of being
// told about changes the server polls each folder's version, a cheap counter that ingest and
// every message change bump in the same transaction as the message.
import { isSystemFolder, type SystemFolder } from "@sesame/core";
import { updateDevice } from "../auth.ts";
import { type FolderVersion, folderVersions } from "../mailbox.ts";
import type { Handler } from "../protocol.ts";
import { type FolderState, INDEX_LAG_MS, loadVersion, unconfirmed } from "../state.ts";
import { child, children, childText, el } from "../wbxml/codec.ts";

const Status = {
  NoChanges: 1,
  Changes: 2,
  MissingParameters: 3,
  SyntaxError: 4,
  InvalidHeartbeat: 5,
  FolderSyncRequired: 7,
} as const;

/**
 * EAS allows 60-3540 seconds, but requests come through CloudFront, which waits at most its
 * origin read timeout (60 seconds by default, 180 with a quota increase) for an answer. The
 * longest heartbeat is therefore deployment configuration, a little under that timeout, and
 * the shortest drops below EAS's 60 to match when it must.
 */
export const EAS_MIN_HEARTBEAT = 60;
export function heartbeatBounds(maxHeartbeat: number): { min: number; max: number } {
  return { min: Math.min(EAS_MIN_HEARTBEAT, maxHeartbeat), max: maxHeartbeat };
}
/** How often a held Ping reads the folder versions: new mail reaches the phone within this, plus a Sync. */
export const POLL_MS = 20_000;

/**
 * When a folder should wake the phone: now if it changed since its last Sync (or was never
 * synced); once the index has caught up if that Sync's read came too soon after a change to be
 * sure it saw it; otherwise never.
 */
function wakeAt(stored: Pick<FolderState, "version" | "versionAt"> | undefined, current: FolderVersion) {
  if (stored?.version === undefined || stored.versionAt === undefined) return -Infinity;
  if (current.version > stored.version) return -Infinity;
  if (unconfirmed(current.updatedAt, stored.versionAt)) return current.updatedAt + INDEX_LAG_MS;
  return Infinity;
}

export const ping: Handler = async (ctx, body) => {
  const { deps, session } = ctx;
  const reply = (status: number, extra: ReturnType<typeof el>[] = []) =>
    el("Ping:Ping", [el("Ping:Status", status), ...extra]);

  // An empty Ping, or one without either part, repeats the last one's.
  const heartbeatText = childText(body, "Ping:HeartbeatInterval");
  const foldersElement = child(body, "Ping:Folders");
  const bounds = heartbeatBounds(deps.config.maxHeartbeat);
  let heartbeat = session.device.pingHeartbeat;
  if (heartbeatText !== undefined) {
    heartbeat = Number(heartbeatText);
    if (!Number.isInteger(heartbeat)) return reply(Status.SyntaxError);
    if (heartbeat < bounds.min || heartbeat > bounds.max) {
      const limit = heartbeat < bounds.min ? bounds.min : bounds.max;
      return reply(Status.InvalidHeartbeat, [el("Ping:HeartbeatInterval", limit)]);
    }
  }
  // A heartbeat remembered under an older, longer limit is cut to the current one.
  if (heartbeat !== undefined) heartbeat = Math.min(heartbeat, bounds.max);
  let folders = session.device.pingFolders;
  if (foldersElement) {
    folders = [...new Set(children(foldersElement, "Ping:Folder").map((f) => childText(f, "Ping:Id") ?? ""))];
    if (folders.length === 0) return reply(Status.SyntaxError);
  }
  if (heartbeat === undefined || !folders?.length) return reply(Status.MissingParameters);
  if (!folders.every(isSystemFolder)) return reply(Status.FolderSyncRequired);
  const watched = folders as SystemFolder[];

  if (
    heartbeat !== session.device.pingHeartbeat ||
    watched.join(",") !== session.device.pingFolders?.join(",")
  ) {
    session.device = await updateDevice(deps, session.device, {
      pingHeartbeat: heartbeat,
      pingFolders: watched,
    });
  }

  const deviceId = session.device.deviceId;
  const stored = new Map(
    await Promise.all(
      watched.map(async (f) => [f, await loadVersion(deps, session.mailboxId, deviceId, f)] as const),
    ),
  );
  const deadline = deps.now() + heartbeat * 1000;
  for (;;) {
    const versions = await folderVersions(deps, session.mailboxId);
    const now = deps.now();
    let next = deadline;
    const due = watched.filter((f) => {
      const at = wakeAt(stored.get(f), versions.get(f) ?? { version: 0, updatedAt: 0 });
      if (at > now) next = Math.min(next, at);
      return at <= now;
    });
    if (due.length) {
      return reply(Status.Changes, [
        el(
          "Ping:Folders",
          due.map((f) => el("Ping:Folder", f)),
        ),
      ]);
    }
    if (now >= deadline) return reply(Status.NoChanges);
    await deps.sleep(Math.min(POLL_MS, next - now));
  }
};
