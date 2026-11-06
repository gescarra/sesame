import type { MessageSummary, SystemFolder } from "@sesame/core/dto";
import { isMailboxFull } from "@sesame/core/quota";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ListView, View } from "../api.ts";
import { displayName, folderLabel, formatListDate, statusLabel } from "../format.ts";
import { useMe, useMessageActions, useMessageList, useSearch } from "../queries.ts";
import { useCompose } from "./Compose.tsx";
import { Icon } from "./Icon.tsx";

/** Delivery states worth calling out in the Sent list. */
const PROBLEMS = new Set(["bounced", "complained", "rejected", "failed", "delayed"]);

const VIEWS: View[] = ["inbox", "flagged", "sent", "archive", "junk", "trash"];

export function MessageList(props: {
  mailboxId: string;
  view: ListView;
  query: string;
  selectedId: string | undefined;
}) {
  const { mailboxId, view, query, selectedId } = props;
  const searching = view === "search";
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Both hooks always run (hooks can't be conditional); only the one in use fetches.
  const folderList = useMessageList(mailboxId, searching ? "inbox" : view, unreadOnly, !searching);
  const searchList = useSearch(mailboxId, searching ? query : "");
  const list = searching ? searchList : folderList;
  const truncated = searching && searchList.data?.pages.some((p) => p.truncated);
  const linkSuffix = searching ? `?q=${encodeURIComponent(query)}` : "";
  const mailbox = useMe().data?.mailboxes.find((m) => m.mailboxId === mailboxId);
  const actions = useMessageActions(mailboxId);
  const navigate = useNavigate();
  const compose = useCompose();

  const messages = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  // Drop selections that scrolled out of existence (moved, deleted).
  useEffect(() => {
    setSelected((prev) => {
      const present = new Set(messages.map((m) => m.id));
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [messages]);

  const sentinel = useRef<HTMLLIElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const ids = [...selected];
  const chosen = messages.filter((m) => selected.has(m.id));
  const allSelected = messages.length > 0 && selected.size === messages.length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const clear = () => setSelected(new Set());
  const run = (fn: () => void) => {
    fn();
    clear();
  };

  return (
    <section className="list" aria-label={`${folderLabel(view)} messages`}>
      <SearchBox mailboxId={mailboxId} query={searching ? query : ""} />
      {mailbox && isMailboxFull(mailbox) ? (
        // The folder rail says this on wider screens.
        <p className="notice error mobile-only">Mailbox full. New mail waits until you empty Trash.</p>
      ) : null}
      <header className="list-header">
        {selected.size > 0 ? (
          <div className="toolbar">
            <input
              type="checkbox"
              aria-label="Select all"
              checked={allSelected}
              onChange={() => (allSelected ? clear() : setSelected(new Set(messages.map((m) => m.id))))}
            />
            <span className="selection-count">{selected.size} selected</span>
            <BatchActions
              view={view}
              chosen={chosen}
              onRead={(read) => run(() => actions.setRead(ids, read))}
              onFlag={(flagged) => run(() => actions.setFlagged(ids, flagged))}
              onMove={(folder) => run(() => actions.move(ids, folder))}
              onDelete={() => run(() => actions.remove(ids, view === "trash"))}
            />
          </div>
        ) : (
          <>
            <h1 className="list-title desktop-only">{folderLabel(view)}</h1>
            <select
              className="view-picker mobile-only"
              aria-label="Folder"
              value={view}
              onChange={(e) => navigate(`/m/${mailboxId}/${e.target.value}`)}
            >
              {searching && <option value="search">{folderLabel("search")}</option>}
              {VIEWS.map((v) => (
                <option key={v} value={v}>
                  {folderLabel(v)}
                </option>
              ))}
            </select>
            <div className="list-tools">
              <button
                type="button"
                className="icon-button mobile-only"
                aria-label="New message"
                title="New message"
                onClick={() => compose.open()}
              >
                <Icon name="compose" />
              </button>
              {view !== "flagged" && !searching && (
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={unreadOnly}
                    onChange={(e) => setUnreadOnly(e.target.checked)}
                  />
                  Unread
                </label>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label="Refresh"
                title="Refresh"
                onClick={() => void list.refetch()}
              >
                <Icon name="refresh" />
              </button>
            </div>
          </>
        )}
      </header>

      {actions.error && <p className="notice error">That didn't work: {actions.error.message}</p>}

      {list.isPending ? (
        <p className="list-empty">Loading…</p>
      ) : list.isError ? (
        <p className="list-empty">
          Couldn't load messages.{" "}
          <button type="button" className="link-button" onClick={() => void list.refetch()}>
            Try again
          </button>
        </p>
      ) : messages.length === 0 ? (
        <p className="list-empty">
          {searching
            ? "No messages match. Junk and Trash are left out unless you add in:anywhere."
            : unreadOnly
              ? "No unread messages."
              : `${folderLabel(view)} is empty.`}
        </p>
      ) : (
        <>
          {truncated && (
            <p className="notice">
              Some words match too many messages, so older results may be missing. Add more words to narrow it
              down.
            </p>
          )}
          <ul className="messages">
            {messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                href={`/m/${mailboxId}/${view}/${m.id}${linkSuffix}`}
                active={m.id === selectedId}
                checked={selected.has(m.id)}
                showRecipient={view === "sent"}
                showFolder={searching}
                onCheck={() => toggle(m.id)}
              />
            ))}
            {hasNextPage && (
              <li ref={sentinel} className="list-more">
                {isFetchingNextPage ? "Loading more…" : ""}
              </li>
            )}
          </ul>
        </>
      )}
    </section>
  );
}

function MessageRow(props: {
  message: MessageSummary;
  href: string;
  active: boolean;
  checked: boolean;
  showRecipient: boolean;
  showFolder?: boolean;
  onCheck: () => void;
}) {
  const { message: m } = props;
  const who = props.showRecipient
    ? `To: ${m.to.map(displayName).join(", ") || "(no recipients)"}`
    : displayName(m.from);
  const classes = [
    "row",
    m.read ? "read" : "unread",
    props.active ? "active" : "",
    props.checked ? "checked" : "",
  ];
  return (
    <li className={classes.join(" ")}>
      <input
        type="checkbox"
        className="row-check"
        aria-label={`Select message from ${who}`}
        checked={props.checked}
        onChange={props.onCheck}
      />
      <Link to={props.href} className="row-link" aria-current={props.active ? "true" : undefined}>
        <span className="row-top">
          <span className="row-from">{who}</span>
          <span className="row-meta">
            {props.showFolder && <span className="status-pill">{folderLabel(m.folder)}</span>}
            {m.deliveryStatus && PROBLEMS.has(m.deliveryStatus) && (
              <span className={`status-pill ${m.deliveryStatus}`}>{statusLabel(m.deliveryStatus)}</span>
            )}
            {m.hasAttachments && <Icon name="paperclip" label="Has attachments" />}
            {m.flagged && <Icon name="flag" label="Flagged" filled />}
            <time dateTime={m.date}>{formatListDate(m.date)}</time>
          </span>
        </span>
        <span className="row-subject">{m.subject || "(no subject)"}</span>
        <span className="row-snippet">{m.snippet}</span>
      </Link>
    </li>
  );
}

function BatchActions(props: {
  view: ListView;
  chosen: MessageSummary[];
  onRead: (read: boolean) => void;
  onFlag: (flagged: boolean) => void;
  onMove: (folder: SystemFolder) => void;
  onDelete: () => void;
}) {
  const anyUnread = props.chosen.some((m) => !m.read);
  const anyUnflagged = props.chosen.some((m) => !m.flagged);
  const { view } = props;
  return (
    <div className="actions">
      <button
        type="button"
        className="icon-button"
        title={anyUnread ? "Mark read" : "Mark unread"}
        onClick={() => props.onRead(anyUnread)}
      >
        <Icon name={anyUnread ? "mailOpen" : "mail"} label={anyUnread ? "Mark read" : "Mark unread"} />
      </button>
      <button
        type="button"
        className="icon-button"
        title={anyUnflagged ? "Flag" : "Unflag"}
        onClick={() => props.onFlag(anyUnflagged)}
      >
        <Icon name="flag" filled={!anyUnflagged} label={anyUnflagged ? "Flag" : "Unflag"} />
      </button>
      {view !== "archive" && view !== "sent" && (
        <button type="button" className="icon-button" title="Archive" onClick={() => props.onMove("archive")}>
          <Icon name="archive" label="Archive" />
        </button>
      )}
      {(view === "junk" || view === "trash" || view === "archive") && (
        <button
          type="button"
          className="icon-button"
          title="Move to Inbox"
          onClick={() => props.onMove("inbox")}
        >
          <Icon name="restore" label="Move to Inbox" />
        </button>
      )}
      <button
        type="button"
        className="icon-button danger"
        title={view === "trash" ? "Delete forever" : "Delete"}
        onClick={() => {
          if (view !== "trash" || confirm(`Delete ${props.chosen.length} message(s) forever?`))
            props.onDelete();
        }}
      >
        <Icon name="trash" label={view === "trash" ? "Delete forever" : "Delete"} />
      </button>
    </div>
  );
}

/** Search box at the top of the list. Submitting opens the search view; clearing goes back to Inbox. */
function SearchBox(props: { mailboxId: string; query: string }) {
  const [value, setValue] = useState(props.query);
  const navigate = useNavigate();
  useEffect(() => setValue(props.query), [props.query]);
  return (
    <form
      className="search"
      aria-label="Search mail"
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        navigate(
          q ? `/m/${props.mailboxId}/search?q=${encodeURIComponent(q)}` : `/m/${props.mailboxId}/inbox`,
        );
      }}
    >
      <Icon name="search" />
      <input
        type="search"
        aria-label="Search mail"
        placeholder="Search mail"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && props.query) navigate(`/m/${props.mailboxId}/inbox`);
        }}
      />
      {props.query && (
        <button
          type="button"
          className="icon-button"
          aria-label="Clear search"
          onClick={() => navigate(`/m/${props.mailboxId}/inbox`)}
        >
          <Icon name="close" />
        </button>
      )}
    </form>
  );
}
