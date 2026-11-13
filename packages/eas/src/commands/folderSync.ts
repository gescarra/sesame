// FolderSync ([MS-ASCMD] 2.2.1.5): the folder list. sesame's folders are fixed, so the sync key
// is the version of that list and no per-device state is needed.

import { EAS_FOLDERS, FOLDER_SYNC_KEY, type Handler } from "../protocol.ts";
import { childText, el } from "../wbxml/codec.ts";

const Status = { Success: 1, InvalidSyncKey: 9, BadRequest: 10 } as const;

export const folderSync: Handler = async (_ctx, body) => {
  const key = childText(body, "FolderHierarchy:SyncKey");
  if (key === undefined) return response(Status.BadRequest);
  if (key === "0") {
    return response(Status.Success, FOLDER_SYNC_KEY, [
      el("FolderHierarchy:Count", EAS_FOLDERS.length),
      ...EAS_FOLDERS.map((f) =>
        el("FolderHierarchy:Add", [
          el("FolderHierarchy:ServerId", f.id),
          el("FolderHierarchy:ParentId", "0"),
          el("FolderHierarchy:DisplayName", f.name),
          el("FolderHierarchy:Type", f.type),
        ]),
      ),
    ]);
  }
  if (key === FOLDER_SYNC_KEY) return response(Status.Success, key, [el("FolderHierarchy:Count", 0)]);
  // Unknown key: the client starts again from 0.
  return response(Status.InvalidSyncKey);
};

function response(status: number, key?: string, changes?: ReturnType<typeof el>[]) {
  return el("FolderHierarchy:FolderSync", [
    el("FolderHierarchy:Status", status),
    key !== undefined && el("FolderHierarchy:SyncKey", key),
    changes && el("FolderHierarchy:Changes", changes),
  ]);
}
