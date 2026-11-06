import type { AttachmentMeta, MessageDetail, OutboundDelivery, SystemFolder } from "@sesame/core/dto";
import { SYSTEM_FOLDERS } from "@sesame/core/folders";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ApiError, api, type ListView, links } from "../api.ts";
import { draftFrom, htmlToText } from "../compose.ts";
import {
  displayName,
  folderLabel,
  formatAddress,
  formatAddresses,
  formatFullDate,
  formatListDate,
  formatSize,
  statusLabel,
} from "../format.ts";
import { buildFrameDocument, hasRemoteImages, referencedContentIds } from "../frame.ts";
import { useMe, useMessage, useMessageActions, useThread } from "../queries.ts";
import { useCompose } from "./Compose.tsx";
import { Icon } from "./Icon.tsx";

export function Reader(props: { mailboxId: string; view: ListView; id: string }) {
  const { mailboxId, view, id } = props;
  const query = useMessage(mailboxId, id);
  const actions = useMessageActions(mailboxId);
  const navigate = useNavigate();
  const compose = useCompose();
  const me = useMe();
  const mine = me.data?.mailboxes.filter((m) => m.mailboxId === mailboxId).map((m) => m.address) ?? [];
  // Search results keep their ?q= so going back returns to them.
  const { search } = useLocation();
  const listUrl = `/m/${mailboxId}/${view}${search}`;

  // Opening an unread message marks it read, once.
  const markedRead = useRef(false);
  const message = query.data?.message;
  useEffect(() => {
    if (message && !message.read && !markedRead.current) {
      markedRead.current = true;
      actions.setRead([message.id], true);
    }
  }, [message, actions]);

  if (query.isPending) return <section className="reader reader-empty">Loading…</section>;
  if (query.isError || !message) {
    const gone = query.error instanceof ApiError && query.error.status === 404;
    return (
      <section className="reader reader-empty">
        <p>{gone ? "This message no longer exists." : "Couldn't load this message."}</p>
        <Link to={listUrl}>Back to {folderLabel(view)}</Link>
      </section>
    );
  }

  /** Actions that take the message out of this view close it. */
  const leave = (fn: () => void) => {
    fn();
    navigate(listUrl);
  };
  const ids = [message.id];
  const inTrash = message.folder === "trash";
  const reply = (mode: "reply" | "replyAll" | "forward") => {
    const { text, html } = query.data.body;
    const bodyText = text?.trim() ? text : html ? htmlToText(html) : "";
    compose.open(draftFrom(mode, message, bodyText, mine));
  };

  return (
    <section className="reader" aria-label="Message">
      <header className="reader-toolbar toolbar">
        <Link to={listUrl} className="icon-button mobile-only" aria-label={`Back to ${folderLabel(view)}`}>
          <Icon name="back" />
        </Link>
        <div className="actions">
          <button type="button" className="icon-button" title="Reply" onClick={() => reply("reply")}>
            <Icon name="reply" label="Reply" />
          </button>
          <button type="button" className="icon-button" title="Reply all" onClick={() => reply("replyAll")}>
            <Icon name="replyAll" label="Reply all" />
          </button>
          <button type="button" className="icon-button" title="Forward" onClick={() => reply("forward")}>
            <Icon name="forward" label="Forward" />
          </button>
          <span className="divider" />
          {message.folder === "inbox" ? (
            <button
              type="button"
              className="icon-button"
              title="Archive"
              onClick={() => leave(() => actions.move(ids, "archive"))}
            >
              <Icon name="archive" label="Archive" />
            </button>
          ) : (
            message.folder !== "sent" && (
              <button
                type="button"
                className="icon-button"
                title="Move to Inbox"
                onClick={() => leave(() => actions.move(ids, "inbox"))}
              >
                <Icon name="restore" label="Move to Inbox" />
              </button>
            )
          )}
          {message.folder !== "junk" && message.folder !== "sent" && (
            <button
              type="button"
              className="icon-button"
              title="Mark as junk"
              onClick={() => leave(() => actions.move(ids, "junk"))}
            >
              <Icon name="junk" label="Mark as junk" />
            </button>
          )}
          <button
            type="button"
            className="icon-button danger"
            title={inTrash ? "Delete forever" : "Delete"}
            onClick={() => {
              if (!inTrash || confirm("Delete this message forever?"))
                leave(() => actions.remove(ids, inTrash));
            }}
          >
            <Icon name="trash" label={inTrash ? "Delete forever" : "Delete"} />
          </button>
          <span className="divider" />
          <button
            type="button"
            className="icon-button"
            title="Mark unread"
            onClick={() => leave(() => actions.setRead(ids, false))}
          >
            <Icon name="mail" label="Mark unread" />
          </button>
          <button
            type="button"
            className={message.flagged ? "icon-button on" : "icon-button"}
            title={message.flagged ? "Unflag" : "Flag"}
            aria-pressed={message.flagged}
            onClick={() => actions.setFlagged(ids, !message.flagged)}
          >
            <Icon name="flag" filled={message.flagged} label={message.flagged ? "Unflag" : "Flag"} />
          </button>
          <MoveMenu current={message.folder} onMove={(folder) => leave(() => actions.move(ids, folder))} />
          <a className="icon-button" href={links.raw(mailboxId, message.id)} title="Download original (.eml)">
            <Icon name="download" label="Download original" />
          </a>
        </div>
      </header>

      {actions.error && <p className="notice error">That didn't work: {actions.error.message}</p>}

      <article className="reader-body">
        <h1 className="subject">{message.subject || "(no subject)"}</h1>
        <Headers message={message} />
        {message.delivery && <DeliveryStatus delivery={message.delivery} />}
        <AuthWarning message={message} />
        <Attachments mailboxId={mailboxId} message={message} />
        <Body
          mailboxId={mailboxId}
          message={message}
          html={query.data.body.html}
          text={query.data.body.text}
        />
        <Thread mailboxId={mailboxId} view={view} message={message} />
      </article>
    </section>
  );
}

function MoveMenu(props: { current: SystemFolder; onMove: (folder: SystemFolder) => void }) {
  return (
    <select
      className="move-picker"
      aria-label="Move to folder"
      value=""
      onChange={(e) => {
        const folder = e.target.value as SystemFolder;
        if (folder) props.onMove(folder);
      }}
    >
      <option value="">Move to…</option>
      {SYSTEM_FOLDERS.filter((f) => f !== props.current && f !== "sent").map((f) => (
        <option key={f} value={f}>
          {folderLabel(f)}
        </option>
      ))}
    </select>
  );
}

function Headers({ message }: { message: MessageDetail }) {
  return (
    <dl className="headers">
      <dt>From</dt>
      <dd>
        <strong>{displayName(message.from)}</strong>
        {message.from?.name && <span className="muted"> &lt;{message.from.address}&gt;</span>}
      </dd>
      {message.to.length > 0 && (
        <>
          <dt>To</dt>
          <dd>{formatAddresses(message.to)}</dd>
        </>
      )}
      {message.cc.length > 0 && (
        <>
          <dt>Cc</dt>
          <dd>{formatAddresses(message.cc)}</dd>
        </>
      )}
      {message.replyTo && message.replyTo.length > 0 && (
        <>
          <dt>Reply-To</dt>
          <dd>{message.replyTo.map(formatAddress).join(", ")}</dd>
        </>
      )}
      <dt>Date</dt>
      <dd>
        <time dateTime={message.date}>{formatFullDate(message.date)}</time>
      </dd>
    </dl>
  );
}

/** Where a sent message got to, per recipient. Updated as SES reports back. */
function DeliveryStatus({ delivery }: { delivery: OutboundDelivery }) {
  const entries = Object.entries(delivery.recipients).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return (
    <details className="delivery" open={delivery.status !== "delivered" && delivery.status !== "sent"}>
      <summary>
        <span className={`status-pill ${delivery.status}`}>{statusLabel(delivery.status)}</span>
        <span className="muted">
          {" "}
          {entries.length === 1 ? "1 recipient" : `${entries.length} recipients`}
        </span>
      </summary>
      <ul>
        {entries.map(([address, r]) => (
          <li key={address}>
            <span className={`status-pill ${r.status}`}>{statusLabel(r.status)}</span> {address}
            {r.detail && <div className="muted delivery-detail">{r.detail}</div>}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Flags messages SES judged suspicious, so a convincing junk message isn't trusted by accident. */
function AuthWarning({ message }: { message: MessageDetail }) {
  const auth = message.auth;
  if (!auth) return null;
  const problems = [
    auth.spam === "FAIL" && "SES classified it as spam",
    auth.dmarc === "FAIL" && "it failed DMARC, so the sender may be forged",
    auth.spf === "FAIL" && auth.dkim === "FAIL" && "it failed both SPF and DKIM",
  ].filter(Boolean);
  if (problems.length === 0) return null;
  return <p className="notice warning">Be careful with this message: {problems.join("; ")}.</p>;
}

function Attachments({ mailboxId, message }: { mailboxId: string; message: MessageDetail }) {
  const files = message.attachments.filter((a) => !a.inline);
  if (files.length === 0) return null;
  return (
    <ul className="attachments" aria-label="Attachments">
      {files.map((a) => (
        <li key={a.partId}>
          <a href={links.attachment(mailboxId, message.id, a.partId)} download>
            <Icon name="paperclip" />
            <span className="attachment-name">{a.filename}</span>
            <span className="muted">{formatSize(a.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Body(props: {
  mailboxId: string;
  message: MessageDetail;
  html: string | undefined;
  text: string | undefined;
}) {
  const { mailboxId, message, html, text } = props;
  const [allowRemote, setAllowRemote] = useState(false);

  // Inline parts the HTML actually references, each resolved to a presigned URL.
  const parts = useMemo(() => {
    if (!html) return [];
    const byCid = new Map(message.attachments.filter((a) => a.contentId).map((a) => [a.contentId, a]));
    return referencedContentIds(html).flatMap((cid) => {
      const part = byCid.get(cid);
      return part ? [part as AttachmentMeta & { contentId: string }] : [];
    });
  }, [html, message.attachments]);
  const urls = useQueries({
    queries: parts.map((p) => ({
      queryKey: ["inline", mailboxId, message.id, p.partId],
      queryFn: () => api.inlineImageUrl(mailboxId, message.id, p.partId),
      staleTime: 4 * 60_000,
    })),
  });
  const resolved = urls.every((u) => !u.isPending);
  const inlineImages = useMemo(() => {
    const map = new Map<string, string>();
    parts.forEach((p, i) => {
      const url = urls[i]?.data?.url;
      if (url) map.set(p.contentId, url);
    });
    return map;
  }, [parts, urls]);

  const doc = useMemo(
    () =>
      html && resolved
        ? buildFrameDocument(html, { inlineImages, allowRemoteImages: allowRemote })
        : undefined,
    [html, resolved, inlineImages, allowRemote],
  );

  if (!html) {
    return <pre className="text-body">{text?.trim() || "(This message has no text.)"}</pre>;
  }
  return (
    <>
      {!allowRemote && hasRemoteImages(html) && (
        <p className="notice">
          <Icon name="image" /> Remote images are blocked to protect your privacy.{" "}
          <button type="button" className="link-button" onClick={() => setAllowRemote(true)}>
            Show images
          </button>
        </p>
      )}
      {doc ? (
        <iframe
          className="html-body"
          title="Message body"
          // No allow-scripts and no allow-same-origin: the body can't run code or touch the app.
          // Popups let links open in a new tab, outside the sandbox.
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={doc}
        />
      ) : (
        <p className="muted">Loading images…</p>
      )}
    </>
  );
}

function Thread({ mailboxId, view, message }: { mailboxId: string; view: ListView; message: MessageDetail }) {
  const { search } = useLocation();
  const thread = useThread(mailboxId, message.threadId);
  const others = thread.data?.messages ?? [];
  if (others.length < 2) return null;
  return (
    <section className="thread" aria-label="Conversation">
      <h2>Conversation ({others.length})</h2>
      <ol>
        {others.map((m) => (
          <li key={m.id} className={m.id === message.id ? "current" : m.read ? "" : "unread"}>
            {m.id === message.id ? (
              <span>
                {displayName(m.from)} · {formatListDate(m.date)} (this message)
              </span>
            ) : (
              <Link to={`/m/${mailboxId}/${view}/${m.id}${search}`}>
                {displayName(m.from)} · {formatListDate(m.date)} · {m.snippet}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
