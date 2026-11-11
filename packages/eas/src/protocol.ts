// Protocol constants shared by the commands.
import type { SystemFolder } from "@sesame/core";
import type { Session } from "./auth.ts";
import type { Deps } from "./deps.ts";
import type { EasRequest } from "./request.ts";
import type { Element } from "./wbxml/codec.ts";

export const PROTOCOL_VERSION = "14.1";
export const WBXML_TYPE = "application/vnd.ms-sync.wbxml";

/** Status codes any 14.x command can return in its top-level Status ([MS-ASCMD] 2.2.2). */
export const GlobalStatus = {
  InvalidContent: 101,
  InvalidWbxml: 102,
  ServerError: 110,
  DeviceNotProvisioned: 142,
  PolicyRefresh: 143,
  InvalidPolicyKey: 144,
} as const;

/** What a command handler sees: the request, the signed-in mailbox and its device. */
export interface CommandContext {
  deps: Deps;
  req: EasRequest;
  session: Session & { device: NonNullable<Session["device"]> };
}

/**
 * A response with binary parts ([MS-ASCMD] 2.2.2.10.1), for clients that ask for multipart
 * ItemOperations: the WBXML refers to part n with ItemOperations:Part instead of inlining it.
 */
export interface MultipartReply {
  root: Element;
  /** Parts 1, 2, …; part 0 is the WBXML. */
  parts: Buffer[];
}

/** A response element, a multipart reply, or null for an empty 200 (a successful SendMail). */
export type Handler = (
  ctx: CommandContext,
  body: Element | undefined,
) => Promise<Element | MultipartReply | null>;

export const MULTIPART_TYPE = "application/vnd.ms-sync.multipart";

/**
 * The folders a phone sees. The ServerId is sesame's folder name, which is also the Sync
 * CollectionId. Type is from [MS-ASCMD] 2.2.3.186.3: 2 Inbox, 4 Deleted Items, 5 Sent Items,
 * 12 user-created mail folder (EAS has no Junk or Archive type).
 */
export const EAS_FOLDERS: readonly { id: SystemFolder; name: string; type: number }[] = [
  { id: "inbox", name: "Inbox", type: 2 },
  { id: "sent", name: "Sent", type: 5 },
  { id: "trash", name: "Trash", type: 4 },
  { id: "junk", name: "Junk", type: 12 },
  { id: "archive", name: "Archive", type: 12 },
];

/**
 * FolderSync state is the version of EAS_FOLDERS, the same for every device. Bump it, and teach
 * FolderSync the difference from the previous version, whenever the folder list changes.
 */
export const FOLDER_SYNC_KEY = "1";
