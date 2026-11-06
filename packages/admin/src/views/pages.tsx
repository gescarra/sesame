import type { SessionUser } from "@sesame/api/session";
import type { AddressItem, MailboxItem, MemberItem, PurgeItem, SuppressionItem } from "@sesame/core";
import type { AuditEntry, DeadMessage, MailboxDeletion, Pipeline, PipelineStatus } from "@sesame/ops";
import type { FC } from "hono/jsx";
import { type Flash, formatTime, Layout, Pill, Usage } from "./layout.tsx";

interface PageProps {
  user: SessionUser;
  flash: Flash;
}

// --- Overview -------------------------------------------------------------------

export interface SesAccount {
  production: boolean;
  enforcement: string;
  max24Hour: number;
  maxRate: number;
  sentLast24Hours: number;
}

export interface AlarmRow {
  name: string;
  state: string;
  reason: string;
  updated: string;
}

export interface OverviewData {
  ses: SesAccount | { error: string };
  alarms: AlarmRow[] | { error: string };
  queues: PipelineStatus[] | { error: string };
  counts: { domains: number; mailboxes: number; suppressions: number };
}

const failed = <T,>(v: T | { error: string }): v is { error: string } =>
  typeof v === "object" && v !== null && "error" in v;

export const OverviewPage: FC<PageProps & { data: OverviewData }> = ({ user, flash, data }) => (
  <Layout title="Overview" section="overview" user={user} flash={flash}>
    <div class="grid">
      <div class="card">
        <div class="muted small">Domains</div>
        <div class="stat">
          <a href="/admin/domains">{data.counts.domains}</a>
        </div>
      </div>
      <div class="card">
        <div class="muted small">Mailboxes</div>
        <div class="stat">
          <a href="/admin/mailboxes">{data.counts.mailboxes}</a>
        </div>
      </div>
      <div class="card">
        <div class="muted small">Suppressed addresses</div>
        <div class="stat">
          <a href="/admin/suppressions">{data.counts.suppressions}</a>
        </div>
      </div>
    </div>

    <section class="card">
      <h2>SES sending</h2>
      {failed(data.ses) ? (
        <p class="muted">Couldn't read the SES account: {data.ses.error}</p>
      ) : (
        <table>
          <tbody>
            <tr>
              <th>Access</th>
              <td>
                {data.ses.production ? (
                  <Pill tone="ok">Production</Pill>
                ) : (
                  <span>
                    <Pill tone="warn">Sandbox</Pill>{" "}
                    <span class="muted">Only verified addresses and the mailbox simulator receive mail.</span>
                  </span>
                )}
              </td>
            </tr>
            <tr>
              <th>Status</th>
              <td>
                <Pill tone={data.ses.enforcement === "HEALTHY" ? "ok" : "bad"}>{data.ses.enforcement}</Pill>
              </td>
            </tr>
            <tr>
              <th>Last 24 hours</th>
              <td>
                {data.ses.sentLast24Hours} of {data.ses.max24Hour} messages, at most {data.ses.maxRate} a
                second
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </section>

    <section class="card">
      <h2>Queues</h2>
      {failed(data.queues) ? (
        <p class="muted">Couldn't read the queues: {data.queues.error}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Pipeline</th>
              <th class="num">Waiting</th>
              <th class="num">In flight</th>
              <th class="num">Dead letters</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.queues.map((q) => (
              <tr>
                <td>
                  <a href={`/admin/queues/${q.pipeline}`}>{q.pipeline}</a>
                </td>
                <td class="num">{q.queued}</td>
                <td class="num">{q.inFlight}</td>
                <td class="num">{q.dead ? <Pill tone="bad">{q.dead}</Pill> : 0}</td>
                <td class="num">{q.dead ? <RedriveButton pipeline={q.pipeline} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>

    <section class="card">
      <h2>Alarms</h2>
      {failed(data.alarms) ? (
        <p class="muted">Couldn't read the alarms: {data.alarms.error}</p>
      ) : data.alarms.length === 0 ? (
        <p class="muted">No alarms found.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Alarm</th>
              <th>State</th>
              <th class="hide-narrow">Since</th>
            </tr>
          </thead>
          <tbody>
            {data.alarms.map((a) => (
              <tr>
                <td title={a.reason}>{a.name}</td>
                <td>
                  <Pill tone={a.state === "OK" ? "ok" : a.state === "ALARM" ? "bad" : "plain"}>
                    {a.state === "INSUFFICIENT_DATA" ? "No data" : a.state}
                  </Pill>
                </td>
                <td class="hide-narrow muted">{a.updated ? formatTime(a.updated) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  </Layout>
);

const RedriveButton: FC<{ pipeline: Pipeline }> = ({ pipeline }) => (
  <form class="inline" method="post" action={`/admin/queues/${pipeline}/redrive`}>
    <button type="submit" class="secondary">
      Redrive
    </button>
  </form>
);

// --- Domains --------------------------------------------------------------------

export interface DomainRow {
  domain: string;
  catchAll?: string | undefined;
  ses?: { verified: boolean; verification: string; dkim: string; mailFrom: string } | undefined;
}

export const DomainsPage: FC<PageProps & { domains: DomainRow[]; mailboxes: MailboxItem[] }> = ({
  user,
  flash,
  domains,
  mailboxes,
}) => (
  <Layout title="Domains" section="domains" user={user} flash={flash}>
    <p class="lede">
      Domains sesame accepts mail for. Terraform sets up each domain's SES identity and DNS; the status comes
      from SES.
    </p>
    <section class="card">
      {domains.length === 0 ? (
        <p class="muted">No domains yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Domain</th>
              <th>SES</th>
              <th class="hide-narrow">DKIM</th>
              <th class="hide-narrow">MAIL FROM</th>
              <th>Catch-all</th>
            </tr>
          </thead>
          <tbody>
            {domains.map((d) => (
              <tr>
                <td>{d.domain}</td>
                <td>
                  {d.ses ? (
                    <Pill tone={d.ses.verified ? "ok" : "warn"}>{d.ses.verification}</Pill>
                  ) : (
                    <Pill tone="bad">Not in SES</Pill>
                  )}
                </td>
                <td class="hide-narrow">{d.ses?.dkim ?? ""}</td>
                <td class="hide-narrow">{d.ses?.mailFrom ?? ""}</td>
                <td>
                  <form class="row" method="post" action={`/admin/domains/${d.domain}/catch-all`}>
                    <select name="address" aria-label={`Catch-all mailbox for ${d.domain}`}>
                      <option value="">None</option>
                      {mailboxes.map((m) => (
                        <option value={m.primaryAddress} selected={m.primaryAddress === d.catchAll}>
                          {m.primaryAddress}
                        </option>
                      ))}
                    </select>
                    <button type="submit" class="secondary">
                      Save
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
    <section class="card">
      <h2>Add a domain</h2>
      <form class="row" method="post" action="/admin/domains">
        <label>
          Domain
          <input name="domain" required placeholder="example.com" />
        </label>
        <button type="submit">Add domain</button>
      </form>
      <p class="muted small">
        This only adds the domain to the directory. To receive and send mail for it, it also needs an SES
        identity and DNS records, which the <code>ses-domain</code> Terraform module creates.
      </p>
    </section>
  </Layout>
);

// --- Mailboxes ------------------------------------------------------------------

export interface MailboxRow {
  mailbox: MailboxItem;
  aliases: number;
  members: number;
}

export const MailboxesPage: FC<
  PageProps & { rows: MailboxRow[]; domains: string[]; purges: PurgeItem[] }
> = ({ user, flash, rows, domains, purges }) => (
  <Layout title="Mailboxes" section="mailboxes" user={user} flash={flash}>
    <section class="card">
      {rows.length === 0 ? (
        <p class="muted">No mailboxes yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Address</th>
              <th class="hide-narrow">Name</th>
              <th>Storage</th>
              <th class="num hide-narrow">Aliases</th>
              <th class="num hide-narrow">Members</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ mailbox: m, aliases, members }) => (
              <tr>
                <td>
                  <a href={`/admin/mailboxes/${m.mailboxId}`}>{m.primaryAddress}</a>
                </td>
                <td class="hide-narrow">{m.displayName ?? ""}</td>
                <td>
                  <Usage used={m.usedBytes ?? 0} quota={m.quotaBytes} />
                </td>
                <td class="num hide-narrow">{aliases}</td>
                <td class="num hide-narrow">{members}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
    {purges.length ? (
      <section class="card">
        <h2>Being deleted</h2>
        <p class="muted small">
          These mailboxes are gone from the directory; their stored mail is being purged. A purge finishes
          about 15 minutes after it starts, with a final pass for mail that was already on its way.
        </p>
        <table>
          <thead>
            <tr>
              <th>Address</th>
              <th class="hide-narrow">Deleted by</th>
              <th>Since</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {purges.map((p) => (
              <tr>
                <td>{p.address}</td>
                <td class="hide-narrow">{p.requestedBy}</td>
                <td class="muted">{formatTime(p.requestedAt)}</td>
                <td class="num">
                  <form class="inline" method="post" action={`/admin/purges/${p.mailboxId}/retry`}>
                    <button type="submit" class="secondary">
                      Restart purge
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    ) : null}
    <section class="card">
      <h2>Add a mailbox</h2>
      {domains.length === 0 ? (
        <p class="muted">
          Add a <a href="/admin/domains">domain</a> first.
        </p>
      ) : (
        <form class="row" method="post" action="/admin/mailboxes">
          <label>
            Address
            <input name="address" type="email" required placeholder={`someone@${domains[0]}`} />
          </label>
          <label>
            Display name
            <input name="name" placeholder="Optional" />
          </label>
          <label>
            Quota (MB)
            <input name="quota" type="number" min="1" step="any" placeholder="No limit" />
          </label>
          <label>
            Owner's sign-in email
            <input name="owner" type="email" placeholder="Defaults to the address" />
          </label>
          <button type="submit">Add mailbox</button>
        </form>
      )}
    </section>
  </Layout>
);

export const MailboxPage: FC<
  PageProps & { mailbox: MailboxItem; aliases: AddressItem[]; members: MemberItem[] }
> = ({ user, flash, mailbox: m, aliases, members }) => {
  const base = `/admin/mailboxes/${m.mailboxId}`;
  return (
    <Layout title={m.primaryAddress} section="mailboxes" user={user} flash={flash}>
      <p class="lede">
        {m.displayName ? `${m.displayName} · ` : ""}
        <code>{m.mailboxId}</code> · created {formatTime(m.createdAt)}
      </p>

      <section class="card">
        <h2>Storage</h2>
        <p>
          <Usage used={m.usedBytes ?? 0} quota={m.quotaBytes} />
          {m.quotaBytes === undefined ? " used, no quota" : ""}
        </p>
        <form class="row" method="post" action={`${base}/quota`}>
          <label>
            Quota (MB)
            <input
              name="quota"
              type="number"
              min="1"
              step="any"
              value={m.quotaBytes ? String(Number((m.quotaBytes / 1048576).toPrecision(4))) : ""}
              placeholder="No limit"
            />
          </label>
          <button type="submit">Save quota</button>
        </form>
        <p class="muted small">
          Leave it empty for no limit. Mail held for a full mailbox waits in the ingest dead-letter queue;
          after raising the quota, <a href="/admin/queues/ingest">redrive it</a>.
        </p>
      </section>

      <section class="card">
        <h2>Aliases</h2>
        {aliases.length === 0 ? (
          <p class="muted">No aliases.</p>
        ) : (
          <table>
            <tbody>
              {aliases.map((a) => (
                <tr>
                  <td>{a.address}</td>
                  <td class="num">
                    <form class="inline" method="post" action={`${base}/aliases/remove`}>
                      <input type="hidden" name="alias" value={a.address} />
                      <button type="submit" class="danger">
                        Remove
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form class="row" method="post" action={`${base}/aliases`}>
          <label>
            New alias
            <input
              name="alias"
              type="email"
              required
              placeholder={`sales@${m.primaryAddress.split("@")[1]}`}
            />
          </label>
          <button type="submit">Add alias</button>
        </form>
      </section>

      <section class="card">
        <h2>Who can open it</h2>
        {members.length === 0 ? (
          <p class="muted">Nobody yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Sign-in email</th>
                <th>Role</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((mem) => (
                <tr>
                  <td>{mem.userId}</td>
                  <td>{mem.role}</td>
                  <td class="num">
                    <form class="inline" method="post" action={`${base}/members/revoke`}>
                      <input type="hidden" name="email" value={mem.userId} />
                      <button type="submit" class="danger">
                        Revoke
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form class="row" method="post" action={`${base}/members`}>
          <label>
            Sign-in email
            <input name="email" type="email" required />
          </label>
          <label>
            Role
            <select name="role">
              <option value="owner">owner</option>
              <option value="delegate">delegate</option>
            </select>
          </label>
          <button type="submit">Grant access</button>
        </form>
      </section>

      <section class="card">
        <h2>Delete this mailbox</h2>
        <p class="muted">
          Removes the mailbox, its addresses and everyone's access, and permanently deletes all of its mail.
        </p>
        <p>
          <a href={`${base}/delete`}>Delete mailbox…</a>
        </p>
      </section>
    </Layout>
  );
};

export const DeleteMailboxPage: FC<PageProps & { plan: MailboxDeletion }> = ({ user, flash, plan }) => {
  const m = plan.mailbox;
  const aliases = plan.addresses.filter((a) => a.address !== m.primaryAddress);
  return (
    <Layout title={`Delete ${m.primaryAddress}?`} section="mailboxes" user={user} flash={flash}>
      <section class="card">
        <p>
          <strong>This can't be undone.</strong>
        </p>
        <ul>
          <li>
            All of its mail is permanently deleted, with attachments and the search index (
            <Usage used={m.usedBytes ?? 0} quota={undefined} />
            ).
          </li>
          <li>
            {aliases.length ? "Its addresses are" : "Its address is"} freed:{" "}
            {plan.addresses.map((a) => a.address).join(", ")}. Mail sent there afterwards is dropped, unless
            the domain has another catch-all mailbox.
          </li>
          <li>
            {plan.members.length
              ? `${plan.members.map((mem) => mem.userId).join(", ")} can no longer open it.`
              : "Nobody can open it any more."}
          </li>
          {plan.catchAllDomains.length ? (
            <li>
              It stops being the catch-all of {plan.catchAllDomains.join(", ")}, so mail to unknown addresses
              there is dropped.
            </li>
          ) : null}
          <li>Mail it already queued is still sent, but its delivery status isn't recorded.</li>
        </ul>
        <form method="post" action={`/admin/mailboxes/${m.mailboxId}/delete`}>
          <p>
            <label>
              Type {m.primaryAddress} to confirm
              <input name="confirm" required autocomplete="off" spellcheck={false} />
            </label>
          </p>
          <p class="row">
            <button type="submit" class="danger">
              Delete mailbox and its mail
            </button>{" "}
            <a href={`/admin/mailboxes/${m.mailboxId}`}>Cancel</a>
          </p>
        </form>
      </section>
    </Layout>
  );
};

// --- Suppressions, queues, activity ---------------------------------------------

export const SuppressionsPage: FC<PageProps & { items: SuppressionItem[] }> = ({ user, flash, items }) => (
  <Layout title="Suppressed addresses" section="suppressions" user={user} flash={flash}>
    <p class="lede">
      Addresses that bounced permanently or reported mail as spam. sesame refuses to send to them until
      they're removed here, which is only safe once you know the address works again.
    </p>
    <section class="card">
      {items.length === 0 ? (
        <p class="muted">No suppressed addresses.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Address</th>
              <th>Reason</th>
              <th class="hide-narrow">Detail</th>
              <th class="hide-narrow">Since</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr>
                <td>{s.address}</td>
                <td>
                  <Pill tone="bad">{s.reason}</Pill>
                </td>
                <td class="hide-narrow muted small">{s.detail ?? ""}</td>
                <td class="hide-narrow muted">{formatTime(s.at)}</td>
                <td class="num">
                  <form class="inline" method="post" action="/admin/suppressions/remove">
                    <input type="hidden" name="address" value={s.address} />
                    <button type="submit" class="danger">
                      Remove
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  </Layout>
);

export const QueuePage: FC<
  PageProps & { pipeline: Pipeline; status?: PipelineStatus; dead: DeadMessage[] }
> = ({ user, flash, pipeline, status, dead }) => (
  <Layout title={`${pipeline} queue`} section="overview" user={user} flash={flash}>
    <p class="lede">
      {status
        ? `${status.queued} waiting, ${status.inFlight} in flight, ${status.dead} in the dead-letter queue.`
        : ""}{" "}
      <a href="/admin">Back to overview</a>
    </p>
    <section class="card">
      <h2>Dead letters</h2>
      {dead.length === 0 ? (
        <p class="muted">The dead-letter queue is empty.</p>
      ) : (
        <>
          <p class="muted small">
            Up to 10 messages, left in place. Find the cause in the Lambda's logs, fix it, then redrive: every
            consumer is idempotent, so a redrive is safe to repeat.
          </p>
          <table>
            <thead>
              <tr>
                <th>First sent</th>
                <th class="num hide-narrow">Receives</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {dead.map((m) => (
                <tr>
                  <td class="muted">{formatTime(m.sentAt)}</td>
                  <td class="num hide-narrow">{m.receiveCount}</td>
                  <td>{m.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <RedriveButton pipeline={pipeline} />
          </p>
        </>
      )}
    </section>
  </Layout>
);

export const ActivityPage: FC<PageProps & { entries: AuditEntry[] }> = ({ user, flash, entries }) => (
  <Layout title="Activity" section="activity" user={user} flash={flash}>
    <p class="lede">Changes made in this console over the last 180 days, newest first.</p>
    <section class="card">
      {entries.length === 0 ? (
        <p class="muted">Nothing yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr>
                <td class="muted">{formatTime(e.at)}</td>
                <td>{e.actor}</td>
                <td>
                  {e.action} <span class="muted">{e.detail}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  </Layout>
);

// --- Errors ---------------------------------------------------------------------

export const ForbiddenPage: FC<{ user: SessionUser; group: string }> = ({ user, group }) => (
  <Layout title="Admins only" flash={{}}>
    <section class="card">
      <p>
        You're signed in as {user.email}, but your session doesn't include the <code>{group}</code> group.
      </p>
      <p class="muted">
        If an administrator just added you to it, sign in again to pick it up.{" "}
        <a href="/api/auth/login?return=/admin">Sign in again</a>
      </p>
    </section>
  </Layout>
);

export const ErrorPage: FC<{ title: string; message: string }> = ({ title, message }) => (
  <Layout title={title} flash={{}}>
    <section class="card">
      <p>{message}</p>
      <p>
        <a href="/admin">Back to overview</a>
      </p>
    </section>
  </Layout>
);
