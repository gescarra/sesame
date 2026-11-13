// SendMail, SmartReply and SmartForward ([MS-ASCMD] 2.2.1.16-18). The phone sends MIME; sesame
// takes the recipients from its headers (EAS has no envelope) and hands it to queueOutgoing,
// which routes it exactly like web app mail and files the Sent copy. Success is an empty body.
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  directoryKeys,
  domainOf,
  findMessage,
  isValidAddress,
  type MessageItem,
  normalizeAddress,
  OutgoingError,
  type OutgoingErrorCode,
  queueOutgoing,
} from "@sesame/core";
import { ComposeError, type ComposeKind, editHeaders, recompose } from "../compose.ts";
import { parseServerId } from "../ids.ts";
import { MimeMessage, parseAddresses } from "../mime.ts";
import type { CommandContext, Handler } from "../protocol.ts";
import { child, childText, type Element, el } from "../wbxml/codec.ts";

/** ComposeMail status values, from the common status codes in [MS-ASCMD] 2.2.2. */
const Status = {
  InvalidContent: 101,
  InvalidMime: 107,
  ServerError: 110,
  MailboxQuotaExceeded: 113,
  SendQuotaExceeded: 115,
  RecipientUnresolved: 116,
  NoRecipient: 119,
  SubmissionFailed: 120,
  TooLarge: 122,
  ItemNotFound: 150,
} as const;

const OUTGOING_STATUS: Record<OutgoingErrorCode, number> = {
  "no-recipients": Status.NoRecipient,
  "too-many-recipients": Status.SubmissionFailed,
  "mailbox-not-found": Status.ServerError,
  "bad-from": Status.SubmissionFailed,
  "unknown-recipient": Status.RecipientUnresolved,
  "mailbox-full": Status.MailboxQuotaExceeded,
  "recipient-full": Status.SubmissionFailed,
  suppressed: Status.SubmissionFailed,
  "rate-limited": Status.SendQuotaExceeded,
};

/** SES takes at most 40 MB per message, headers and encoding included. */
export const MAX_MIME_BYTES = 40 * 1024 * 1024;
/** How long a ClientId is remembered: iOS gives up resending well within a day. */
const CLIENT_ID_SECONDS = 24 * 3600;
const CLIENT_ID = /^[\x21-\x7e]{1,64}$/;

/** The message the phone replies to or forwards. It may have moved since, so any folder will do. */
async function findSource(ctx: CommandContext, source: Element | undefined) {
  const parsed = parseServerId(childText(source, "ComposeMail:ItemId") ?? "");
  const folderId = childText(source, "ComposeMail:FolderId");
  if (!parsed || (folderId !== undefined && folderId !== parsed.folder)) return undefined;
  return findMessage(ctx.deps, ctx.session.mailboxId, parsed.ulid);
}

/** Records the ClientId; false when it was already sent. */
async function claim(ctx: CommandContext, key: { pk: string; sk: string }): Promise<boolean> {
  try {
    await ctx.deps.doc.send(
      new PutCommand({
        TableName: ctx.deps.config.directoryTable,
        Item: {
          ...key,
          type: "eas-send",
          at: new Date(ctx.deps.now()).toISOString(),
          ttl: Math.floor(ctx.deps.now() / 1000) + CLIENT_ID_SECONDS,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

/** Forgets a ClientId whose message wasn't sent, so the phone's next try goes through. */
async function release(ctx: CommandContext, key: { pk: string; sk: string }) {
  try {
    await ctx.deps.doc.send(new DeleteCommand({ TableName: ctx.deps.config.directoryTable, Key: key }));
  } catch (err) {
    ctx.deps.log("error", "could not release ActiveSync ClientId", { error: String(err) });
  }
}

async function send(
  ctx: CommandContext,
  kind: ComposeKind,
  raw: Buffer,
  original: MessageItem | undefined,
  replaceMime: boolean,
) {
  const msg = MimeMessage.parse(raw);
  const recipients = parseAddresses([...msg.getAll("To"), ...msg.getAll("Cc"), ...msg.getAll("Bcc")]);
  if (recipients.some((r) => !isValidAddress(r.address))) throw new ComposeError(Status.RecipientUnresolved);
  const phoneFrom = parseAddresses(msg.getAll("From"))[0];
  const ownFrom = phoneFrom && isValidAddress(phoneFrom.address) ? phoneFrom : undefined;

  return queueOutgoing(ctx.deps, {
    mailboxId: ctx.session.mailboxId,
    userId: ctx.session.userId,
    ...(ownFrom ? { from: ownFrom.address } : {}),
    // iOS fills From with whatever the account was set up with; a shared mailbox's member may
    // have typed their own address. Send from the mailbox instead of refusing.
    fallbackFrom: true,
    recipients: recipients.map((r) => r.address),
    compose: async ({ id, date, from, mailbox }) => {
      const kept = ownFrom && normalizeAddress(ownFrom.address) === from;
      const envelope = {
        messageId: `<${id.toLowerCase()}@${domainOf(from)}>`,
        date,
        from: kept ? ownFrom : { name: mailbox.displayName ?? "", address: from },
        rewriteFrom: !kept,
      };
      const out =
        original && !replaceMime
          ? await recompose(ctx.deps, raw, envelope, kind, original)
          : editHeaders(msg, envelope, kind, original);
      if (out.length > MAX_MIME_BYTES) throw new ComposeError(Status.TooLarge);
      return out;
    },
  });
}

function composeHandler(kind: ComposeKind): Handler {
  const root = `ComposeMail:${kind}`;
  const fail = (status: number) => el(root, [el("ComposeMail:Status", status)]);
  return async (ctx, body) => {
    const clientId = childText(body, "ComposeMail:ClientId");
    const mimeEl = child(body, "ComposeMail:Mime");
    const raw = mimeEl?.opaque ?? (mimeEl?.text ? Buffer.from(mimeEl.text, "utf8") : undefined);
    if (body?.tag !== root || !clientId || !CLIENT_ID.test(clientId)) return fail(Status.InvalidContent);
    if (!raw?.length) return fail(Status.InvalidMime);
    if (raw.length > MAX_MIME_BYTES) return fail(Status.TooLarge);

    let original: MessageItem | undefined;
    if (kind !== "SendMail") {
      original = await findSource(ctx, child(body, "ComposeMail:Source"));
      if (!original) return fail(Status.ItemNotFound);
    }

    const fields = { cmd: kind, mailboxId: ctx.session.mailboxId };
    const marker = directoryKeys.easSend(ctx.session.userId, ctx.session.device.deviceId, clientId);
    if (!(await claim(ctx, marker))) {
      ctx.deps.log("info", "ActiveSync resend ignored", fields);
      return null;
    }
    try {
      const result = await send(
        ctx,
        kind,
        raw,
        original,
        child(body, "ComposeMail:ReplaceMime") !== undefined,
      );
      ctx.deps.log("info", "ActiveSync message queued", { ...fields, id: result.id });
      return null;
    } catch (err) {
      await release(ctx, marker);
      if (err instanceof OutgoingError) {
        ctx.deps.log("info", "ActiveSync message refused", { ...fields, code: err.code });
        return fail(OUTGOING_STATUS[err.code]);
      }
      if (err instanceof ComposeError) return fail(err.status);
      throw err;
    }
  };
}

export const sendMail = composeHandler("SendMail");
export const smartReply = composeHandler("SmartReply");
export const smartForward = composeHandler("SmartForward");
