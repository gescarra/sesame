import type { MailboxAccess } from "@sesame/core/dto";
import { useEffect } from "react";
import { NavLink, useNavigate } from "react-router";
import { api, type ListView, type View } from "../api.ts";
import { folderLabel, formatSize } from "../format.ts";
import { useFolders, useMe } from "../queries.ts";
import { useCompose } from "./Compose.tsx";
import { Icon, type IconName } from "./Icon.tsx";

const ICONS: Record<View, IconName> = {
  inbox: "inbox",
  flagged: "flag",
  sent: "send",
  archive: "archive",
  junk: "junk",
  trash: "trash",
};

/** Inbox first, then flagged, then the rest in a familiar order. */
const ORDER: View[] = ["inbox", "flagged", "sent", "archive", "junk", "trash"];

export function FolderRail(props: { mailbox: MailboxAccess; mailboxes: MailboxAccess[]; view: ListView }) {
  const { mailbox, mailboxes, view } = props;
  const me = useMe();
  const folders = useFolders(mailbox.mailboxId);
  const navigate = useNavigate();
  const compose = useCompose();
  const counts = new Map(folders.data?.folders.map((f) => [f.name, f]));
  const inboxUnread = counts.get("inbox")?.unread ?? 0;

  useEffect(() => {
    document.title =
      inboxUnread > 0 ? `(${inboxUnread}) ${folderLabel(view)} · sesame` : `${folderLabel(view)} · sesame`;
  }, [inboxUnread, view]);

  return (
    <nav className="rail" aria-label="Folders">
      <div className="brand">sesame</div>

      <button type="button" className="button primary compose-button" onClick={() => compose.open()}>
        <Icon name="compose" />
        New message
      </button>

      {mailboxes.length > 1 ? (
        <select
          className="mailbox-picker"
          aria-label="Mailbox"
          value={mailbox.mailboxId}
          onChange={(e) => navigate(`/m/${e.target.value}/inbox`)}
        >
          {mailboxes.map((m) => (
            <option key={m.mailboxId} value={m.mailboxId}>
              {m.displayName ? `${m.displayName} (${m.address})` : m.address}
            </option>
          ))}
        </select>
      ) : (
        <div className="mailbox-name" title={mailbox.address}>
          {mailbox.displayName ?? mailbox.address}
        </div>
      )}

      <ul className="folders">
        {ORDER.map((f) => {
          const count = f === "flagged" ? undefined : counts.get(f);
          // Unread counts matter in inbox and junk; elsewhere they're noise.
          const badge = f === "inbox" || f === "junk" ? count?.unread : undefined;
          return (
            <li key={f}>
              <NavLink
                to={`/m/${mailbox.mailboxId}/${f}`}
                className={({ isActive }) => (isActive ? "active" : "")}
              >
                <Icon name={ICONS[f]} />
                <span className="folder-label">{folderLabel(f)}</span>
                {badge ? <span className="badge">{badge}</span> : null}
              </NavLink>
            </li>
          );
        })}
      </ul>

      <Storage mailbox={mailbox} />

      <div className="account">
        <span className="account-email" title={me.data?.email}>
          {me.data?.name ?? me.data?.email}
        </span>
        <button type="button" className="link-button" onClick={() => void api.signOut()}>
          Sign out
        </button>
      </div>
    </nav>
  );
}

function Storage({ mailbox }: { mailbox: MailboxAccess }) {
  const { usedBytes, quotaBytes } = mailbox;
  if (quotaBytes === undefined) {
    return <div className="storage">{formatSize(usedBytes)} used</div>;
  }
  const ratio = Math.min(1, usedBytes / quotaBytes);
  const level = ratio >= 1 ? " full" : ratio >= 0.9 ? " high" : "";
  return (
    <div className={`storage${level}`}>
      <div className="storage-bar" aria-hidden="true">
        <div style={{ width: `${Math.max(ratio * 100, 2)}%` }} />
      </div>
      {ratio >= 1 ? (
        <span>Mailbox full. New mail waits until you empty Trash.</span>
      ) : (
        <span>
          {formatSize(usedBytes)} of {formatSize(quotaBytes)} used
        </span>
      )}
    </div>
  );
}
