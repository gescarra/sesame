// MoveItems ([MS-ASCMD] 2.2.1.12): moves messages between folders. The message keeps its ulid,
// so the new ServerId is the destination folder with the same ulid. Both folders' snapshots are
// edited to match, so the next Sync doesn't send the move back as a delete and an add.
import { changeMessage, isSystemFolder, MessageConflictError, MessageNotFoundError } from "@sesame/core";
import { parseServerId, serverId } from "../ids.ts";
import type { Handler } from "../protocol.ts";
import { editSnapshots, flagsOf } from "../state.ts";
import { children, childText, el } from "../wbxml/codec.ts";

const Status = {
  InvalidSource: 1,
  InvalidDestination: 2,
  Success: 3,
  SameFolder: 4,
  Failure: 5,
  Locked: 7,
} as const;

export const moveItems: Handler = async (ctx, body) => {
  const { deps, session } = ctx;
  const responses = [];
  for (const move of children(body, "Move:Move")) {
    const srcMsgId = childText(move, "Move:SrcMsgId") ?? "";
    const srcFolder = childText(move, "Move:SrcFldId");
    const dstFolder = childText(move, "Move:DstFldId");
    const reply = (status: number, dstMsgId?: string) =>
      el("Move:Response", [
        el("Move:SrcMsgId", srcMsgId),
        el("Move:Status", status),
        dstMsgId !== undefined && el("Move:DstMsgId", dstMsgId),
      ]);

    const src = parseServerId(srcMsgId);
    if (!src || src.folder !== srcFolder) {
      responses.push(reply(Status.InvalidSource));
      continue;
    }
    if (!isSystemFolder(dstFolder)) {
      responses.push(reply(Status.InvalidDestination));
      continue;
    }
    if (dstFolder === src.folder) {
      responses.push(reply(Status.SameFolder));
      continue;
    }
    try {
      const m = await changeMessage(deps, session.mailboxId, src.ulid, { folder: dstFolder });
      const deviceId = session.device.deviceId;
      await editSnapshots(deps, session.mailboxId, deviceId, src.folder, (s) => s.delete(src.ulid));
      await editSnapshots(deps, session.mailboxId, deviceId, dstFolder, (s) => s.set(src.ulid, flagsOf(m)));
      responses.push(reply(Status.Success, serverId(dstFolder, src.ulid)));
    } catch (err) {
      if (err instanceof MessageNotFoundError) responses.push(reply(Status.InvalidSource));
      else if (err instanceof MessageConflictError) responses.push(reply(Status.Locked));
      else throw err;
    }
  }
  return el("Move:MoveItems", responses);
};
