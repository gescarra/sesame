// Mailbox read and state endpoints. Every route under /mailboxes/:mbx checks membership first.
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { type DownloadUrl, isSystemFolder, type MessageItem } from "@sesame/core";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { appPasswordRoutes } from "./appPasswords.ts";
import type { Env } from "./deps.ts";
import {
  type Changes,
  deleteMessage,
  folderCounts,
  getMembership,
  listFlagged,
  listFolder,
  listMailboxes,
  listThread,
  MAX_PAGE,
  readBody,
  requireMessage,
  toDetail,
  toSummary,
  updateMessage,
} from "./mail.ts";
import { search } from "./search.ts";
import { createUpload, sendMessage } from "./send.ts";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PRESIGN_SECONDS = 300;
const MAX_BATCH = 100;
/** Raster types a browser can show inline without running script. SVG is excluded. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type MailboxEnv = Env & { Variables: { mailboxId: string } };

export const apiRoutes = new Hono<MailboxEnv>();

apiRoutes.post("/uploads", async (c) => {
  return c.json(await createUpload(c.var.deps, c.var.user, await jsonBody(c.req.raw)));
});

apiRoutes.route("/app-passwords", appPasswordRoutes);

apiRoutes.get("/me", async (c) => {
  const user = c.var.user;
  return c.json({
    email: user.email,
    name: user.name ?? null,
    mailboxes: await listMailboxes(c.var.deps, user.email),
  });
});

/** 404 rather than 403 for mailboxes the user can't see, so ids can't be probed. */
const requireMailbox: MiddlewareHandler<MailboxEnv> = async (c, next) => {
  const mailboxId = c.req.param("mbx") ?? "";
  if (!ULID.test(mailboxId) || !(await getMembership(c.var.deps, mailboxId, c.var.user.email))) {
    throw new HTTPException(404, { message: "mailbox not found" });
  }
  c.set("mailboxId", mailboxId);
  await next();
};

apiRoutes.use("/mailboxes/:mbx/*", requireMailbox);

apiRoutes.post("/mailboxes/:mbx/send", async (c) => {
  const result = await sendMessage(c.var.deps, c.var.user, c.var.mailboxId, await jsonBody(c.req.raw));
  return c.json(result, 202);
});

apiRoutes.get("/mailboxes/:mbx/search", async (c) => {
  const q = c.req.query("q") ?? "";
  if (q.length > 500) throw new HTTPException(400, { message: "search is too long" });
  const cursor = c.req.query("cursor") || undefined;
  const limit = parseLimit(c.req.query("limit"));
  return c.json(await search(c.var.deps, c.var.mailboxId, cursor ? { q, limit, cursor } : { q, limit }));
});

apiRoutes.get("/mailboxes/:mbx/folders", async (c) => {
  return c.json({ folders: await folderCounts(c.var.deps, c.var.mailboxId) });
});

apiRoutes.get("/mailboxes/:mbx/messages", async (c) => {
  const limit = parseLimit(c.req.query("limit"));
  const cursor = c.req.query("cursor") || undefined;
  if (isTrue(c.req.query("flagged"))) {
    return c.json(await listFlagged(c.var.deps, c.var.mailboxId, cursor ? { limit, cursor } : { limit }));
  }
  const folder = c.req.query("folder") ?? "inbox";
  if (!isSystemFolder(folder)) throw new HTTPException(400, { message: "unknown folder" });
  const opts = { folder, limit, unreadOnly: isTrue(c.req.query("unread")) };
  return c.json(await listFolder(c.var.deps, c.var.mailboxId, cursor ? { ...opts, cursor } : opts));
});

apiRoutes.post("/mailboxes/:mbx/messages/batch", async (c) => {
  const body = await jsonBody(c.req.raw);
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BATCH || !ids.every((id) => isUlid(id))) {
    throw new HTTPException(400, { message: `ids must be 1-${MAX_BATCH} message ids` });
  }
  const action = body.action;
  let changes: Changes | "delete";
  switch (action) {
    case "read":
    case "unread":
      changes = { read: action === "read" };
      break;
    case "flag":
    case "unflag":
      changes = { flagged: action === "flag" };
      break;
    case "move":
      if (!isSystemFolder(body.folder)) throw new HTTPException(400, { message: "unknown folder" });
      changes = { folder: body.folder };
      break;
    case "delete":
      changes = "delete";
      break;
    default:
      throw new HTTPException(400, { message: "unknown action" });
  }

  const { deps, mailboxId } = c.var;
  const results: { id: string; ok: boolean; error?: string }[] = [];
  // A few at a time: each one is a read plus a transaction.
  for (let i = 0; i < ids.length; i += 8) {
    const chunk = ids.slice(i, i + 8) as string[];
    const settled = await Promise.allSettled(
      chunk.map((id) =>
        changes === "delete"
          ? deleteMessage(deps, mailboxId, id)
          : updateMessage(deps, mailboxId, id, changes),
      ),
    );
    settled.forEach((r, j) => {
      const id = chunk[j] as string;
      if (r.status === "fulfilled") results.push({ id, ok: true });
      else if (r.reason instanceof HTTPException) results.push({ id, ok: false, error: r.reason.message });
      else throw r.reason;
    });
  }
  return c.json({ results });
});

apiRoutes.get("/mailboxes/:mbx/messages/:id", async (c) => {
  const { deps, mailboxId } = c.var;
  const message = await requireMessage(deps, mailboxId, messageId(c.req.param("id")));
  return c.json({ message: toDetail(message), body: await readBody(deps, message) });
});

apiRoutes.patch("/mailboxes/:mbx/messages/:id", async (c) => {
  const body = await jsonBody(c.req.raw);
  const changes: Changes = {};
  if ("read" in body) {
    if (typeof body.read !== "boolean") throw new HTTPException(400, { message: "read must be a boolean" });
    changes.read = body.read;
  }
  if ("flagged" in body) {
    if (typeof body.flagged !== "boolean")
      throw new HTTPException(400, { message: "flagged must be a boolean" });
    changes.flagged = body.flagged;
  }
  if ("folder" in body) {
    if (!isSystemFolder(body.folder)) throw new HTTPException(400, { message: "unknown folder" });
    changes.folder = body.folder;
  }
  if (Object.keys(changes).length === 0) {
    throw new HTTPException(400, { message: "nothing to change: send read, flagged or folder" });
  }
  const updated = await updateMessage(c.var.deps, c.var.mailboxId, messageId(c.req.param("id")), changes);
  return c.json({ message: toSummary(updated) });
});

apiRoutes.delete("/mailboxes/:mbx/messages/:id", async (c) => {
  const result = await deleteMessage(c.var.deps, c.var.mailboxId, messageId(c.req.param("id")));
  return c.json({ result });
});

apiRoutes.get("/mailboxes/:mbx/messages/:id/attachments/:partId", async (c) => {
  const { deps, mailboxId } = c.var;
  const message = await requireMessage(deps, mailboxId, messageId(c.req.param("id")));
  const part = message.attachments.find((a) => a.partId === c.req.param("partId"));
  if (!part) throw new HTTPException(404, { message: "attachment not found" });
  const inline = isTrue(c.req.query("inline")) && INLINE_TYPES.has(part.contentType.toLowerCase());
  return presignedRedirect(c, message, `att/${part.partId}`, {
    disposition: contentDisposition(inline ? "inline" : "attachment", part.filename),
    contentType: inline ? part.contentType : "application/octet-stream",
  });
});

apiRoutes.get("/mailboxes/:mbx/messages/:id/raw", async (c) => {
  const { deps, mailboxId } = c.var;
  const message = await requireMessage(deps, mailboxId, messageId(c.req.param("id")));
  return presignedRedirect(c, message, "message.eml", {
    disposition: contentDisposition("attachment", `${message.messageUlid}.eml`),
    contentType: "message/rfc822",
  });
});

apiRoutes.get("/mailboxes/:mbx/threads/:threadId", async (c) => {
  const threadId = messageId(c.req.param("threadId"));
  const messages = await listThread(c.var.deps, c.var.mailboxId, threadId);
  if (messages.length === 0) throw new HTTPException(404, { message: "thread not found" });
  return c.json({ threadId, messages });
});

async function presignedRedirect(
  c: Context<MailboxEnv>,
  message: MessageItem,
  object: string,
  opts: { disposition: string; contentType: string },
) {
  const { deps } = c.var;
  const url = await deps.presign(
    new GetObjectCommand({
      Bucket: deps.config.mailBucket,
      Key: `${message.objectPrefix}${object}`,
      ResponseContentDisposition: opts.disposition,
      ResponseContentType: opts.contentType,
    }),
    PRESIGN_SECONDS,
  );
  c.header("Cache-Control", "no-store");
  // The SPA asks for the URL itself to show inline images: it can't follow a cross-origin
  // redirect from fetch(), and its sandboxed message frame can't send the session cookie.
  if (c.req.query("as") === "url") return c.json({ url, expiresIn: PRESIGN_SECONDS } satisfies DownloadUrl);
  return c.redirect(url, 302);
}

/** RFC 6266 with an ASCII fallback and an RFC 5987 UTF-8 name. */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID.test(value);
}

function messageId(value: string | undefined): string {
  if (!isUlid(value)) throw new HTTPException(404, { message: "message not found" });
  return value;
}

function isTrue(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE) {
    throw new HTTPException(400, { message: `limit must be 1-${MAX_PAGE}` });
  }
  return n;
}

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => undefined);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HTTPException(400, { message: "expected a JSON object" });
  }
  return body as Record<string, unknown>;
}
