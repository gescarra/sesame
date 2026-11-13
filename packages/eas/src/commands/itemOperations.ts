// ItemOperations ([MS-ASCMD] 2.2.1.10): fetches a whole message or one attachment, and empties
// Trash. Attachments go as multipart parts when the phone accepts them, base64 otherwise.
import { findMessage, isSystemFolder, MessageNotFoundError, removeMessage } from "@sesame/core";
import { parseFileReference, parseServerId } from "../ids.ts";
import { BodyType, emailData } from "../items.ts";
import { listWindow, ObjectMissingError, readObject } from "../mailbox.ts";
import type { CommandContext, Handler } from "../protocol.ts";
import { parseBodyPreferences } from "../state.ts";
import { child, childText, type Element, el } from "../wbxml/codec.ts";

const Status = {
  Success: 1,
  ProtocolError: 2,
  ServerError: 3,
  NotFound: 6,
  InvalidRange: 8,
  StoreUnknown: 9,
  AttachmentNotFound: 15,
} as const;

/** Messages purged from Trash in one EmptyFolderContents; the phone asks again for the rest. */
const EMPTY_LIMIT = 1000;

interface Output {
  multipart: boolean;
  parts: Buffer[];
}

/** Data inline as base64, or a reference to a new part. */
function dataElement(out: Output, bytes: Buffer): Element {
  if (!out.multipart) return el("ItemOperations:Data", bytes.toString("base64"));
  out.parts.push(bytes);
  return el("ItemOperations:Part", out.parts.length);
}

function parseRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | "invalid" | undefined {
  if (value === undefined) return undefined;
  const m = value.trim().match(/^(\d+)-(\d+)$/);
  if (!m) return "invalid";
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), size - 1);
  return start > end ? "invalid" : { start, end };
}

async function fetchAttachment(
  ctx: CommandContext,
  reference: string,
  options: Element | undefined,
  out: Output,
) {
  const reply = (status: number, properties?: Element[]) =>
    el("ItemOperations:Fetch", [
      el("ItemOperations:Status", status),
      el("AirSyncBase:FileReference", reference),
      properties && el("ItemOperations:Properties", properties),
    ]);
  const ref = parseFileReference(reference);
  const m = ref ? await findMessage(ctx.deps, ctx.session.mailboxId, ref.ulid) : undefined;
  const part = m?.attachments.find((a) => a.partId === ref?.partId);
  if (!m || !part) return reply(Status.AttachmentNotFound);

  const range = parseRange(childText(options, "ItemOperations:Range"), part.size);
  if (range === "invalid") return reply(Status.InvalidRange);
  try {
    const { bytes, size } = await readObject(ctx.deps, `${m.objectPrefix}att/${part.partId}`, range);
    return reply(
      Status.Success,
      [
        el("AirSyncBase:ContentType", part.contentType),
        range && el("ItemOperations:Range", `${range.start}-${range.start + Math.max(bytes.length, 1) - 1}`),
        range && el("ItemOperations:Total", size),
        dataElement(out, bytes),
      ].filter((e): e is Element => Boolean(e)),
    );
  } catch (err) {
    if (err instanceof ObjectMissingError) return reply(Status.AttachmentNotFound);
    throw err;
  }
}

async function fetchMessage(ctx: CommandContext, fetch: Element, options: Element | undefined) {
  const collectionId = childText(fetch, "AirSync:CollectionId");
  const id = childText(fetch, "AirSync:ServerId") ?? "";
  const reply = (status: number, properties?: Element[]) =>
    el("ItemOperations:Fetch", [
      el("ItemOperations:Status", status),
      collectionId !== undefined && el("AirSync:CollectionId", collectionId),
      el("AirSync:ServerId", id),
      properties && el("AirSync:Class", "Email"),
      properties && el("ItemOperations:Properties", properties),
    ]);
  const parsed = parseServerId(id);
  if (!parsed || (collectionId !== undefined && collectionId !== parsed.folder))
    return reply(Status.NotFound);
  const m = await findMessage(ctx.deps, ctx.session.mailboxId, parsed.ulid);
  if (!m || m.folder !== parsed.folder) return reply(Status.NotFound);
  // Opening a message asks for all of it; without a preference, the whole text body.
  const pref = parseBodyPreferences(options)[0] ?? { type: BodyType.Text };
  try {
    const { data } = await emailData(ctx.deps, m, pref);
    return reply(Status.Success, data);
  } catch (err) {
    if (err instanceof ObjectMissingError) return reply(Status.NotFound);
    throw err;
  }
}

async function emptyFolder(ctx: CommandContext, e: Element) {
  const collectionId = childText(e, "AirSync:CollectionId") ?? "";
  const reply = (status: number) =>
    el("ItemOperations:EmptyFolderContents", [
      el("ItemOperations:Status", status),
      el("AirSync:CollectionId", collectionId),
    ]);
  // Only Trash can be emptied: anywhere else "delete" means "move to Trash".
  if (!isSystemFolder(collectionId) || collectionId !== "trash") return reply(Status.ProtocolError);
  const items = await listWindow(ctx.deps, ctx.session.mailboxId, "trash", undefined, EMPTY_LIMIT);
  for (let i = 0; i < items.length; i += 8) {
    await Promise.all(
      items.slice(i, i + 8).map((m) =>
        removeMessage(ctx.deps, ctx.session.mailboxId, m.messageUlid).catch((err) => {
          if (!(err instanceof MessageNotFoundError)) throw err;
        }),
      ),
    );
  }
  return reply(Status.Success);
}

export const itemOperations: Handler = async (ctx, body) => {
  const out: Output = { multipart: ctx.req.params.AcceptMultiPart === "T", parts: [] };
  const responses: Element[] = [];
  for (const op of body?.children ?? []) {
    if (op.tag === "ItemOperations:Fetch") {
      const store = childText(op, "ItemOperations:Store");
      const options = child(op, "ItemOperations:Options");
      const reference = childText(op, "AirSyncBase:FileReference");
      if (store?.toLowerCase() !== "mailbox") {
        responses.push(el("ItemOperations:Fetch", [el("ItemOperations:Status", Status.StoreUnknown)]));
      } else if (reference !== undefined) {
        responses.push(await fetchAttachment(ctx, reference, options, out));
      } else if (child(op, "AirSync:ServerId")) {
        responses.push(await fetchMessage(ctx, op, options));
      } else {
        // LongId (search results) and document libraries aren't supported.
        responses.push(el("ItemOperations:Fetch", [el("ItemOperations:Status", Status.ProtocolError)]));
      }
    } else if (op.tag === "ItemOperations:EmptyFolderContents") {
      responses.push(await emptyFolder(ctx, op));
    } else if (op.tag === "ItemOperations:Move") {
      // Conversation moves: iOS uses MoveItems.
      responses.push(el("ItemOperations:Move", [el("ItemOperations:Status", Status.ProtocolError)]));
    }
  }
  const root = el("ItemOperations:ItemOperations", [
    el("ItemOperations:Status", Status.Success),
    el("ItemOperations:Response", responses),
  ]);
  return out.multipart ? { root, parts: out.parts } : root;
};
