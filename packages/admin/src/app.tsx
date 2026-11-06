// The admin console: a server-rendered app with plain HTML forms and no client JavaScript.
// It shares the distribution's origin and session cookie with the mail app, and only members
// of the admin Cognito group get past the gate.
import { DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { GetAccountCommand, GetEmailIdentityCommand } from "@aws-sdk/client-sesv2";
import { readSession, SESSION_COOKIE } from "@sesame/api/session";
import type { AddressItem, DomainItem, MailboxItem, MemberItem, SuppressionItem } from "@sesame/core";
import {
  addAlias,
  addDomain,
  addMailbox,
  deleteMailbox,
  enqueuePurge,
  grantMember,
  isPipeline,
  listAudit,
  listByType,
  listPendingPurges,
  listSuppressions,
  peekDead,
  planMailboxDeletion,
  queueStatus,
  recordAudit,
  redrive,
  removeAlias,
  removeSuppression,
  revokeMember,
  setCatchAll,
  setQuota,
  UserError,
} from "@sesame/ops";
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { type AdminDeps, type AdminEnv, createDeps, log } from "./deps.ts";
import type { Flash } from "./views/layout.tsx";
import {
  ActivityPage,
  DeleteMailboxPage,
  type DomainRow,
  DomainsPage,
  ErrorPage,
  ForbiddenPage,
  MailboxesPage,
  MailboxPage,
  type OverviewData,
  OverviewPage,
  QueuePage,
  SuppressionsPage,
} from "./views/pages.tsx";
import { STYLES } from "./views/styles.ts";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function flash(c: Context): Flash {
  return { notice: c.req.query("notice"), error: c.req.query("error") };
}

/** Errors worth showing to the admin as-is: bad input rather than a broken dependency. */
function isUserError(err: unknown): err is Error {
  return err instanceof UserError || (err instanceof Error && err.message.startsWith("invalid "));
}

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Runs a change, records it in the activity log and redirects back with a message
 * (post/redirect/get, so a reload never repeats the change).
 */
async function change(
  c: Context<AdminEnv>,
  back: string,
  action: string,
  run: () => Promise<{ notice: string; detail: string }>,
): Promise<Response> {
  const { deps, user } = c.var;
  try {
    const { notice, detail } = await run();
    await recordAudit(deps.directory, { actor: user.email, action, detail }, deps.now());
    deps.log("info", "admin change", { actor: user.email, action, detail });
    return c.redirect(`${back}?notice=${encodeURIComponent(notice)}`, 303);
  } catch (err) {
    if (isUserError(err)) return c.redirect(`${back}?error=${encodeURIComponent(err.message)}`, 303);
    throw err;
  }
}

function settle<T>(result: PromiseSettledResult<T>): T | { error: string } {
  return result.status === "fulfilled" ? result.value : { error: String(result.reason) };
}

async function overview(deps: AdminDeps): Promise<OverviewData> {
  const [account, alarms, queues, domains, mailboxes, suppressions] = await Promise.allSettled([
    deps.ses.send(new GetAccountCommand({})),
    deps.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNamePrefix: `${deps.name}-`, MaxRecords: 100 })),
    queueStatus(deps.queues),
    listByType<DomainItem>(deps.directory, "domain"),
    listByType<MailboxItem>(deps.directory, "mailbox"),
    listByType<SuppressionItem>(deps.directory, "suppression"),
  ]);
  const ses = settle(account);
  const alarmList = settle(alarms);
  const count = (r: PromiseSettledResult<unknown[]>) => (r.status === "fulfilled" ? r.value.length : 0);
  return {
    ses:
      "error" in ses
        ? ses
        : {
            production: ses.ProductionAccessEnabled === true,
            enforcement: ses.EnforcementStatus ?? "UNKNOWN",
            max24Hour: ses.SendQuota?.Max24HourSend ?? 0,
            maxRate: ses.SendQuota?.MaxSendRate ?? 0,
            sentLast24Hours: ses.SendQuota?.SentLast24Hours ?? 0,
          },
    alarms:
      "error" in alarmList
        ? alarmList
        : (alarmList.MetricAlarms ?? []).map((a) => ({
            name: a.AlarmName ?? "",
            state: a.StateValue ?? "",
            reason: a.StateReason ?? "",
            updated: a.StateUpdatedTimestamp?.toISOString() ?? "",
          })),
    queues: settle(queues),
    counts: { domains: count(domains), mailboxes: count(mailboxes), suppressions: count(suppressions) },
  };
}

async function sesStatus(deps: AdminDeps, domain: string): Promise<DomainRow["ses"]> {
  try {
    const res = await deps.ses.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    return {
      verified: res.VerifiedForSendingStatus === true,
      verification: res.VerificationStatus ?? "UNKNOWN",
      dkim: res.DkimAttributes?.Status ?? "",
      mailFrom: res.MailFromAttributes?.MailFromDomainStatus ?? "",
    };
  } catch (err) {
    if ((err as { name?: string }).name === "NotFoundException") return undefined;
    throw err;
  }
}

export function createAdminApp(loadDeps: () => Promise<AdminDeps>) {
  let pending: Promise<AdminDeps> | undefined;
  const app = new Hono<AdminEnv>({ strict: false }).basePath("/admin");

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
      referrerPolicy: "same-origin",
    }),
  );
  app.use(async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "private, no-store");
  });

  app.get("/static/admin.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    c.header("Cache-Control", "public, max-age=3600");
    return c.body(STYLES);
  });

  app.use(async (c, next) => {
    pending ??= loadDeps().catch((err) => {
      pending = undefined; // retry on the next request
      throw err;
    });
    c.set("deps", await pending);
    await next();
  });

  // Forms post from this origin only. Browsers send Origin on every form POST.
  app.use(csrf({ origin: (origin, c) => origin === (c as Context<AdminEnv>).var.deps.config.publicUrl }));

  app.use(async (c, next) => {
    const { config, adminGroup, now } = c.var.deps;
    const user = readSession(config.sessionKey, getCookie(c, SESSION_COOKIE), now());
    if (!user) {
      if (c.req.method !== "GET")
        return c.html(<ErrorPage title="Signed out" message="Sign in and try again." />, 401);
      return c.redirect(`/api/auth/login?return=${encodeURIComponent(c.req.path)}`, 302);
    }
    if (!user.groups?.includes(adminGroup)) {
      c.var.deps.log("warn", "admin access denied", { email: user.email });
      return c.html(<ForbiddenPage user={user} group={adminGroup} />, 403);
    }
    c.set("user", user);
    await next();
  });

  // --- Overview and queues ---

  app.get("/", async (c) =>
    c.html(<OverviewPage user={c.var.user} flash={flash(c)} data={await overview(c.var.deps)} />),
  );

  app.get("/queues/:pipeline", async (c) => {
    const pipeline = c.req.param("pipeline");
    if (!isPipeline(pipeline)) return c.notFound();
    const { queues } = c.var.deps;
    const [status, dead] = await Promise.all([queueStatus(queues), peekDead(queues, pipeline)]);
    return c.html(
      <QueuePage
        user={c.var.user}
        flash={flash(c)}
        pipeline={pipeline}
        status={status.find((s) => s.pipeline === pipeline)}
        dead={dead}
      />,
    );
  });

  app.post("/queues/:pipeline/redrive", async (c) => {
    const pipeline = c.req.param("pipeline");
    if (!isPipeline(pipeline)) return c.notFound();
    return change(c, `/admin/queues/${pipeline}`, "redrove", async () => {
      const r = await redrive(c.var.deps.queues, pipeline);
      if (r.moved === 0) throw new UserError(`${r.from} is already empty`);
      return {
        notice: `Moving about ${r.moved} message(s) back to ${r.to}. Reload in a minute to check.`,
        detail: `${r.moved} message(s) from ${r.from}`,
      };
    });
  });

  // --- Domains ---

  app.get("/domains", async (c) => {
    const { directory } = c.var.deps;
    const [domains, mailboxes] = await Promise.all([
      listByType<DomainItem>(directory, "domain"),
      listByType<MailboxItem>(directory, "mailbox"),
    ]);
    const byId = new Map(mailboxes.map((m) => [m.mailboxId, m.primaryAddress]));
    const rows: DomainRow[] = await Promise.all(
      domains
        .sort((a, b) => a.domain.localeCompare(b.domain))
        .map(async (d) => ({
          domain: d.domain,
          catchAll: d.catchAllMailboxId ? byId.get(d.catchAllMailboxId) : undefined,
          ses: await sesStatus(c.var.deps, d.domain),
        })),
    );
    mailboxes.sort((a, b) => a.primaryAddress.localeCompare(b.primaryAddress));
    return c.html(<DomainsPage user={c.var.user} flash={flash(c)} domains={rows} mailboxes={mailboxes} />);
  });

  app.post("/domains", async (c) => {
    const domain = field(await c.req.parseBody(), "domain");
    return change(c, "/admin/domains", "added domain", async () => {
      const item = await addDomain(c.var.deps.directory, domain);
      return { notice: `Added ${item.domain}.`, detail: item.domain };
    });
  });

  app.post("/domains/:domain/catch-all", async (c) => {
    const domain = c.req.param("domain");
    const address = field(await c.req.parseBody(), "address");
    return change(c, "/admin/domains", "set catch-all", async () => {
      await setCatchAll(c.var.deps.directory, domain, address || null);
      return address
        ? { notice: `Unknown addresses at ${domain} now go to ${address}.`, detail: `${domain} → ${address}` }
        : { notice: `Mail to unknown addresses at ${domain} is dropped.`, detail: `${domain} → none` };
    });
  });

  // --- Mailboxes ---

  app.get("/mailboxes", async (c) => {
    const { directory } = c.var.deps;
    const [mailboxes, addresses, members, domains, purges] = await Promise.all([
      listByType<MailboxItem>(directory, "mailbox"),
      listByType<AddressItem>(directory, "address"),
      listByType<MemberItem>(directory, "member"),
      listByType<DomainItem>(directory, "domain"),
      listPendingPurges(directory),
    ]);
    const tally = (ids: string[]) =>
      ids.reduce((m, id) => m.set(id, (m.get(id) ?? 0) + 1), new Map<string, number>());
    const aliasCount = tally(addresses.filter((a) => a.kind === "alias").map((a) => a.mailboxId));
    const memberCount = tally(members.map((m) => m.mailboxId));
    const rows = mailboxes
      .sort((a, b) => a.primaryAddress.localeCompare(b.primaryAddress))
      .map((m) => ({
        mailbox: m,
        aliases: aliasCount.get(m.mailboxId) ?? 0,
        members: memberCount.get(m.mailboxId) ?? 0,
      }));
    return c.html(
      <MailboxesPage
        user={c.var.user}
        flash={flash(c)}
        rows={rows}
        domains={domains.map((d) => d.domain).sort()}
        purges={purges}
      />,
    );
  });

  app.post("/mailboxes", async (c) => {
    const body = await c.req.parseBody();
    const address = field(body, "address");
    const name = field(body, "name");
    const owner = field(body, "owner");
    const quota = field(body, "quota");
    return change(c, "/admin/mailboxes", "added mailbox", async () => {
      const quotaMb = quota ? Number(quota) : undefined;
      if (quotaMb !== undefined && !(quotaMb > 0))
        throw new UserError("The quota must be a positive number of MB.");
      const m = await addMailbox(c.var.deps.directory, address, {
        ...(name ? { displayName: name } : {}),
        ...(quotaMb ? { quotaMb } : {}),
        ...(owner ? { owner } : {}),
      });
      return {
        notice: `Added ${m.primaryAddress}.`,
        detail: `${m.primaryAddress}, owner ${owner || m.primaryAddress}${quotaMb ? `, quota ${quotaMb} MB` : ""}`,
      };
    });
  });

  app.get("/mailboxes/:id", async (c) => {
    const id = c.req.param("id");
    const { directory } = c.var.deps;
    const [mailboxes, addresses, members] = await Promise.all([
      listByType<MailboxItem>(directory, "mailbox"),
      listByType<AddressItem>(directory, "address"),
      listByType<MemberItem>(directory, "member"),
    ]);
    const mailbox = ULID.test(id) ? mailboxes.find((m) => m.mailboxId === id) : undefined;
    if (!mailbox)
      return c.html(<ErrorPage title="Not found" message="There's no mailbox with that ID." />, 404);
    return c.html(
      <MailboxPage
        user={c.var.user}
        flash={flash(c)}
        mailbox={mailbox}
        aliases={addresses.filter((a) => a.mailboxId === id && a.kind === "alias")}
        members={members.filter((m) => m.mailboxId === id).sort((a, b) => a.userId.localeCompare(b.userId))}
      />,
    );
  });

  /** Mailbox actions address the mailbox by its primary address, which the ops functions take. */
  async function primaryAddress(c: Context<AdminEnv>): Promise<string> {
    const id = c.req.param("id") ?? "";
    const mailboxes = await listByType<MailboxItem>(c.var.deps.directory, "mailbox");
    const mailbox = ULID.test(id) ? mailboxes.find((m) => m.mailboxId === id) : undefined;
    if (!mailbox) throw new UserError("That mailbox no longer exists.");
    return mailbox.primaryAddress;
  }

  app.post("/mailboxes/:id/quota", async (c) => {
    const quota = field(await c.req.parseBody(), "quota");
    return change(c, `/admin/mailboxes/${c.req.param("id")}`, "set quota", async () => {
      const address = await primaryAddress(c);
      const quotaMb = quota ? Number(quota) : null;
      if (quotaMb !== null && !(quotaMb > 0))
        throw new UserError("The quota must be a positive number of MB.");
      await setQuota(c.var.deps.directory, address, quotaMb);
      return quotaMb === null
        ? { notice: "Removed the quota.", detail: `${address}: no limit` }
        : { notice: `The quota is now ${quotaMb} MB.`, detail: `${address}: ${quotaMb} MB` };
    });
  });

  app.post("/mailboxes/:id/aliases", async (c) => {
    const alias = field(await c.req.parseBody(), "alias");
    return change(c, `/admin/mailboxes/${c.req.param("id")}`, "added alias", async () => {
      const address = await primaryAddress(c);
      const item = await addAlias(c.var.deps.directory, alias, address);
      return { notice: `Added ${item.address}.`, detail: `${item.address} → ${address}` };
    });
  });

  app.post("/mailboxes/:id/aliases/remove", async (c) => {
    const alias = field(await c.req.parseBody(), "alias");
    return change(c, `/admin/mailboxes/${c.req.param("id")}`, "removed alias", async () => {
      const address = await primaryAddress(c);
      await removeAlias(c.var.deps.directory, alias);
      return { notice: `Removed ${alias}.`, detail: `${alias} from ${address}` };
    });
  });

  app.post("/mailboxes/:id/members", async (c) => {
    const body = await c.req.parseBody();
    const email = field(body, "email");
    const role = field(body, "role");
    return change(c, `/admin/mailboxes/${c.req.param("id")}`, "granted access", async () => {
      if (role !== "owner" && role !== "delegate") throw new UserError("Choose owner or delegate.");
      const address = await primaryAddress(c);
      const member = await grantMember(c.var.deps.directory, address, email, role);
      return {
        notice: `${member.userId} can now open this mailbox.`,
        detail: `${member.userId} (${role}) on ${address}`,
      };
    });
  });

  app.post("/mailboxes/:id/members/revoke", async (c) => {
    const email = field(await c.req.parseBody(), "email");
    return change(c, `/admin/mailboxes/${c.req.param("id")}`, "revoked access", async () => {
      const address = await primaryAddress(c);
      await revokeMember(c.var.deps.directory, address, email);
      return { notice: `${email} can no longer open this mailbox.`, detail: `${email} on ${address}` };
    });
  });

  app.get("/mailboxes/:id/delete", async (c) => {
    const id = c.req.param("id");
    if (!ULID.test(id)) return c.notFound();
    try {
      const plan = await planMailboxDeletion(c.var.deps.directory, id);
      return c.html(<DeleteMailboxPage user={c.var.user} flash={flash(c)} plan={plan} />);
    } catch (err) {
      if (isUserError(err)) return c.html(<ErrorPage title="Not found" message={err.message} />, 404);
      throw err;
    }
  });

  app.post("/mailboxes/:id/delete", async (c) => {
    const id = c.req.param("id");
    const confirm = field(await c.req.parseBody(), "confirm").toLowerCase();
    const { directory, queues, log } = c.var.deps;
    let plan: Awaited<ReturnType<typeof planMailboxDeletion>>;
    try {
      plan = await planMailboxDeletion(directory, ULID.test(id) ? id : "");
    } catch (err) {
      if (isUserError(err))
        return c.redirect(`/admin/mailboxes?error=${encodeURIComponent(err.message)}`, 303);
      throw err;
    }
    const address = plan.mailbox.primaryAddress;
    if (confirm !== address) {
      return c.redirect(
        `/admin/mailboxes/${id}/delete?error=${encodeURIComponent(`Type ${address} exactly to confirm.`)}`,
        303,
      );
    }
    return change(c, "/admin/mailboxes", "deleted mailbox", async () => {
      await deleteMailbox(directory, plan, c.var.user.email, c.var.deps.now());
      const detail = `${address} (${id}), ${plan.addresses.length} address(es), ${plan.members.length} member(s)`;
      try {
        await enqueuePurge(queues, id);
      } catch (err) {
        // The mailbox is already gone; its purge marker lets an admin restart the purge.
        log("error", "could not start purge", { mailboxId: id, error: String(err) });
        return {
          notice: `Deleted ${address}, but its mail purge didn't start. Use Restart purge below.`,
          detail,
        };
      }
      return { notice: `Deleted ${address}. Its mail is being purged.`, detail };
    });
  });

  app.post("/purges/:id/retry", async (c) => {
    const id = c.req.param("id");
    return change(c, "/admin/mailboxes", "restarted purge", async () => {
      const pending = (await listPendingPurges(c.var.deps.directory)).find((p) => p.mailboxId === id);
      if (!pending) throw new UserError("That purge already finished.");
      await enqueuePurge(c.var.deps.queues, id);
      return { notice: `Restarted the purge of ${pending.address}.`, detail: `${pending.address} (${id})` };
    });
  });

  // --- Suppressions and activity ---

  app.get("/suppressions", async (c) =>
    c.html(
      <SuppressionsPage
        user={c.var.user}
        flash={flash(c)}
        items={await listSuppressions(c.var.deps.directory)}
      />,
    ),
  );

  app.post("/suppressions/remove", async (c) => {
    const address = field(await c.req.parseBody(), "address");
    return change(c, "/admin/suppressions", "removed suppression", async () => {
      if (!address) throw new UserError("No address given.");
      await removeSuppression(c.var.deps.directory, address);
      return { notice: `Mail to ${address} is allowed again.`, detail: address };
    });
  });

  app.get("/activity", async (c) =>
    c.html(
      <ActivityPage user={c.var.user} flash={flash(c)} entries={await listAudit(c.var.deps.directory)} />,
    ),
  );

  app.notFound((c) => c.html(<ErrorPage title="Not found" message="There's no admin page here." />, 404));
  app.onError((err, c) => {
    // Middleware refusals, such as the CSRF check's 403, carry their own response.
    if (err instanceof HTTPException) return err.getResponse();
    log("error", "unhandled error", { method: c.req.method, path: c.req.path, error: String(err) });
    const message =
      c.req.method === "GET"
        ? "This page couldn't load. Try again."
        : "The change may not have been made. Check, then try again.";
    return c.html(<ErrorPage title="Something went wrong" message={message} />, 500);
  });
  return app;
}

export const app = createAdminApp(createDeps);
