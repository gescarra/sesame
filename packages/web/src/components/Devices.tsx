// Phones and other devices: app passwords for adding sesame to the iPhone's Mail app as an
// Exchange account, and the devices that signed in with each one.
import type { AppPasswordSummary, CreateAppPasswordResponse, MailboxAccess } from "@sesame/core/dto";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../api.ts";
import { formatFullDate } from "../format.ts";
import { useAppPasswordActions, useAppPasswords, useMe } from "../queries.ts";
import { Icon } from "./Icon.tsx";

export function Devices() {
  const me = useMe();
  const list = useAppPasswords();
  const { create, revoke } = useAppPasswordActions();
  const [created, setCreated] = useState<CreateAppPasswordResponse>();
  const mailboxes = me.data?.mailboxes ?? [];
  const server = list.data?.server ?? null;
  const back = mailboxes[0] ? `/m/${mailboxes[0].mailboxId}/inbox` : "/";

  return (
    <main className="page">
      <header className="page-header">
        <Link className="icon-button" to={back} aria-label="Back to mail">
          <Icon name="back" />
        </Link>
        <h1>Phones and other devices</h1>
      </header>

      <p className="muted">
        Add sesame to the Mail app on an iPhone as an Exchange account. Each phone signs in with an app
        password that opens one mailbox. Revoke it here if the phone is lost or replaced.
      </p>

      {list.isSuccess && !server && (
        <p className="notice warning">
          ActiveSync isn't turned on for this sesame, so phones can't connect yet.
        </p>
      )}

      {created ? (
        <Created
          created={created}
          server={server}
          username={me.data?.email ?? ""}
          onDone={() => setCreated(undefined)}
        />
      ) : (
        <CreateForm
          mailboxes={mailboxes}
          pending={create.isPending}
          error={create.error}
          onCreate={(body) => create.mutate(body, { onSuccess: setCreated })}
        />
      )}

      <section aria-labelledby="passwords-heading">
        <h2 id="passwords-heading">App passwords</h2>
        {list.isPending && <p className="muted">Loading…</p>}
        {list.isError && <p className="notice error">The list couldn't be loaded. Try again in a moment.</p>}
        {list.data?.passwords.length === 0 && <p className="muted">None yet.</p>}
        <ul className="app-passwords">
          {list.data?.passwords.map((p) => (
            <PasswordRow
              key={p.id}
              password={p}
              revoking={revoke.isPending && revoke.variables === p.id}
              onRevoke={() => {
                const devices = p.devices.length
                  ? ` ${p.devices.length === 1 ? "The phone using it" : "The phones using it"} will stop syncing.`
                  : "";
                if (confirm(`Revoke "${p.label}"?${devices}`)) revoke.mutate(p.id);
              }}
            />
          ))}
        </ul>
        {revoke.error && <p className="notice error">{errorText(revoke.error)}</p>}
      </section>
    </main>
  );
}

function CreateForm(props: {
  mailboxes: MailboxAccess[];
  pending: boolean;
  error: unknown;
  onCreate: (body: { mailboxId: string; label: string }) => void;
}) {
  const [label, setLabel] = useState("");
  const [mailboxId, setMailboxId] = useState(props.mailboxes[0]?.mailboxId ?? "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (label.trim() && mailboxId) props.onCreate({ mailboxId, label: label.trim() });
  };
  return (
    <form className="card create-password" onSubmit={submit}>
      <h2>New app password</h2>
      <label className="stacked">
        <span>Name</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Work iPhone"
          maxLength={64}
          required
        />
      </label>
      {props.mailboxes.length > 1 && (
        <label className="stacked">
          <span>Mailbox</span>
          <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
            {props.mailboxes.map((m) => (
              <option key={m.mailboxId} value={m.mailboxId}>
                {m.displayName ? `${m.displayName} (${m.address})` : m.address}
              </option>
            ))}
          </select>
        </label>
      )}
      {Boolean(props.error) && <p className="notice error">{errorText(props.error)}</p>}
      <div>
        <button type="submit" className="button primary" disabled={props.pending || !label.trim()}>
          {props.pending ? "Creating…" : "Create app password"}
        </button>
      </div>
    </form>
  );
}

function Created(props: {
  created: CreateAppPasswordResponse;
  server: string | null;
  username: string;
  onDone: () => void;
}) {
  const { password, appPassword } = props.created;
  return (
    <section className="card created-password" aria-live="polite">
      <h2>"{appPassword.label}" is ready</h2>
      <p>Copy the password now. It won't be shown again.</p>
      <p className="password">{password}</p>
      <ol className="setup-steps">
        <li>
          On the iPhone, open <strong>Settings › Apps › Mail › Mail Accounts › Add Account</strong> and choose{" "}
          <strong>Microsoft Exchange</strong>.
        </li>
        <li>
          Enter the email <strong>{appPassword.address}</strong>, tap <strong>Next</strong>, then{" "}
          <strong>Configure Manually</strong>.
        </li>
        <li>
          <dl className="setup-values">
            <dt>Server</dt>
            <dd>{props.server ?? "(ActiveSync isn't turned on)"}</dd>
            <dt>Domain</dt>
            <dd>leave empty</dd>
            <dt>Username</dt>
            <dd>{props.username}</dd>
            <dt>Password</dt>
            <dd>the password above, with or without the dashes</dd>
          </dl>
        </li>
        <li>
          Turn on <strong>Mail</strong> only. Contacts, calendars and notes aren't synced.
        </li>
      </ol>
      <button type="button" className="button" onClick={props.onDone}>
        Done
      </button>
    </section>
  );
}

function PasswordRow(props: { password: AppPasswordSummary; revoking: boolean; onRevoke: () => void }) {
  const p = props.password;
  return (
    <li className="card">
      <div className="app-password-head">
        <div>
          <strong>{p.label}</strong>
          <div className="muted">
            {p.address ?? "A mailbox you no longer have access to"} · created {formatFullDate(p.createdAt)}
            {p.lastUsedAt ? ` · last used ${formatFullDate(p.lastUsedAt)}` : " · never used"}
          </div>
        </div>
        <button type="button" className="button" onClick={props.onRevoke} disabled={props.revoking}>
          {props.revoking ? "Revoking…" : "Revoke"}
        </button>
      </div>
      {p.devices.length > 0 && (
        <ul className="devices">
          {p.devices.map((d) => (
            <li key={d.deviceId}>
              {d.model ?? d.deviceType}
              {d.os ? `, ${d.os}` : ""}{" "}
              <span className="muted">· last synced {formatFullDate(d.lastSeenAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Try again.";
}
