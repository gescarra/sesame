// GetItemEstimate ([MS-ASCMD] 2.2.1.9): how many changes the next Sync of each folder would send.
import { isSystemFolder } from "@sesame/core";
import type { Handler } from "../protocol.ts";
import { emailOptions, loadState, parseOptions, type SyncOptions, unpack } from "../state.ts";
import { child, children, childText, el } from "../wbxml/codec.ts";
import { diffFolder, folderItems } from "./sync.ts";

const Status = { Success: 1, InvalidCollection: 2, NotPrimed: 3, InvalidSyncKey: 4 } as const;

export const getItemEstimate: Handler = async (ctx, body) => {
  const collections = children(child(body, "GetItemEstimate:Collections"), "GetItemEstimate:Collection");
  const responses = await Promise.all(
    collections.map(async (c) => {
      const collectionId = childText(c, "GetItemEstimate:CollectionId") ?? "";
      const key = childText(c, "AirSync:SyncKey");
      const reply = (status: number, estimate?: number) =>
        el("GetItemEstimate:Response", [
          el("GetItemEstimate:Status", status),
          el("GetItemEstimate:Collection", [
            el("GetItemEstimate:CollectionId", collectionId),
            estimate !== undefined && el("GetItemEstimate:Estimate", estimate),
          ]),
        ]);

      if (!isSystemFolder(collectionId)) return reply(Status.InvalidCollection);
      if (!key || key === "0") return reply(Status.NotPrimed);
      const state = await loadState(
        ctx.deps,
        ctx.session.mailboxId,
        ctx.session.device.deviceId,
        collectionId,
      );
      if (!state || (key !== state.key && key !== state.prevKey)) return reply(Status.InvalidSyncKey);

      const options: SyncOptions = { ...state.options, ...parseOptions(emailOptions(c)) };
      const snapshot = unpack(key === state.key ? state.snapshot : state.prevSnapshot);
      const diff = diffFolder(snapshot, await folderItems(ctx, collectionId, options));
      return reply(Status.Success, diff.deletes.length + diff.changes.length + diff.adds.length);
    }),
  );
  return el("GetItemEstimate:GetItemEstimate", responses);
};
