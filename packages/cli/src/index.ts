#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { GetEmailIdentityCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  type AddressItem,
  type DomainItem,
  type MailboxItem,
  type MemberItem,
  normalizeAddress,
} from "@sesame/core";
import {
  addAlias,
  addDomain,
  addMailbox,
  type Ctx,
  deleteMailbox,
  enqueuePurge,
  grantMember,
  isPipeline,
  listByType,
  mailboxByAddress,
  PIPELINES,
  peekDead,
  planMailboxDeletion,
  type QueueCtx,
  queueStatus,
  redrive,
  removeAlias,
  revokeMember,
  setCatchAll,
  setQuota,
  UserError,
} from "@sesame/ops";
import { type ReindexCtx, reindexMailbox } from "./reindex.ts";

const USAGE = `usage: sesame <command> [options]

  domain add <domain>
  domain list
  domain status <domain>                 SES verification and DKIM status
  domain catch-all <domain> <address>    deliver unknown addresses to a mailbox
  domain catch-all <domain> --clear

  mailbox add <address> [--name <display name>] [--quota-mb <n>] [--owner <login email>]
  mailbox list
  mailbox quota <address> <MB|none>      set or remove a storage quota
  mailbox delete <address> --yes         delete a mailbox and permanently purge its mail

  alias add <alias> <mailbox address>
  alias remove <alias>
  alias list

  member grant <mailbox address> <login email> [--role owner|delegate]
  member revoke <mailbox address> <login email>
  member list

  search reindex [<mailbox address>]     rebuild the search index (all mailboxes by default)
    [--no-body]                          index headers and attachment names only

  queue status                           messages waiting, in flight and dead, per pipeline
  queue peek <ingest|send|events>        show up to 10 dead messages without removing them
    [--json]                             print the full message bodies
  queue redrive <ingest|send|events>     move dead messages back to their queue to retry

Environment:
  SESAME_DIRECTORY_TABLE   directory table name (default: sesame-directory)
  SESAME_MAIL_TABLE        mail table name (default: sesame-mail)
  SESAME_MAIL_BUCKET       mail bucket, needed by search reindex
  SESAME_NAME              name prefix of the deployment's queues (default: sesame)
  AWS_REGION / AWS_PROFILE standard AWS SDK configuration`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      "quota-mb": { type: "string" },
      owner: { type: "string" },
      role: { type: "string", default: "owner" },
      clear: { type: "boolean", default: false },
      "no-body": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [noun, verb, ...args] = positionals;
  if (values.help || !noun) {
    console.log(USAGE);
    return;
  }

  const ctx: Ctx = {
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    table: process.env.SESAME_DIRECTORY_TABLE ?? "sesame-directory",
  };
  const need = (n: number) => {
    if (args.length < n) throw new UserError(`"${noun} ${verb}" needs ${n} argument(s)\n\n${USAGE}`);
    return args as string[];
  };

  switch (`${noun} ${verb}`) {
    case "domain add": {
      const [domain] = need(1);
      const item = await addDomain(ctx, domain as string);
      console.log(`added domain ${item.domain}`);
      return;
    }
    case "domain list": {
      const domains = await listByType<DomainItem>(ctx, "domain");
      const mailboxes = new Map(
        (await listByType<MailboxItem>(ctx, "mailbox")).map((m) => [m.mailboxId, m.primaryAddress]),
      );
      table(
        ["domain", "catch-all"],
        domains.map((d) => [
          d.domain,
          d.catchAllMailboxId ? (mailboxes.get(d.catchAllMailboxId) ?? d.catchAllMailboxId) : "",
        ]),
      );
      return;
    }
    case "domain status": {
      const [domain] = need(1);
      const res = await new SESv2Client({}).send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      console.log(`verified for sending: ${res.VerifiedForSendingStatus ? "yes" : "no"}`);
      console.log(`verification status:  ${res.VerificationStatus ?? "unknown"}`);
      console.log(`DKIM status:          ${res.DkimAttributes?.Status ?? "unknown"}`);
      console.log(
        `MAIL FROM status:     ${res.MailFromAttributes?.MailFromDomainStatus ?? "not configured"}`,
      );
      return;
    }
    case "domain catch-all": {
      const [domain, address] = need(1);
      if (!values.clear && !address) throw new UserError("give a mailbox address or --clear");
      await setCatchAll(ctx, domain as string, values.clear ? null : (address as string));
      console.log(values.clear ? `cleared catch-all for ${domain}` : `catch-all for ${domain} → ${address}`);
      return;
    }
    case "mailbox add": {
      const [address] = need(1);
      const quotaMb = values["quota-mb"] ? Number(values["quota-mb"]) : undefined;
      if (quotaMb !== undefined && !(quotaMb > 0))
        throw new UserError("--quota-mb must be a positive number");
      const mbx = await addMailbox(ctx, address as string, {
        ...(values.name ? { displayName: values.name } : {}),
        ...(quotaMb ? { quotaMb } : {}),
        ...(values.owner ? { owner: values.owner } : {}),
      });
      console.log(
        `added mailbox ${mbx.primaryAddress} (${mbx.mailboxId}), owner ${values.owner ?? mbx.primaryAddress}`,
      );
      return;
    }
    case "mailbox list": {
      const rows = await listByType<MailboxItem>(ctx, "mailbox");
      table(
        ["address", "name", "id", "used MB", "quota MB"],
        rows.map((m) => [
          m.primaryAddress,
          m.displayName ?? "",
          m.mailboxId,
          ((m.usedBytes ?? 0) / 1048576).toFixed(1),
          m.quotaBytes ? String(Number((m.quotaBytes / 1048576).toPrecision(3))) : "",
        ]),
      );
      return;
    }
    case "mailbox quota": {
      const [address, size] = need(2);
      const quotaMb = size === "none" ? null : Number(size);
      if (quotaMb !== null && !(quotaMb > 0)) throw new UserError("give a size in MB, or none");
      const m = await setQuota(ctx, address as string, quotaMb);
      const used = `${((m.usedBytes ?? 0) / 1048576).toFixed(1)} MB used`;
      console.log(
        quotaMb === null
          ? `removed the quota of ${m.primaryAddress} (${used})`
          : `quota of ${m.primaryAddress} is ${quotaMb} MB (${used})`,
      );
      return;
    }
    case "mailbox delete": {
      const [address] = need(1);
      const mailbox = await mailboxByAddress(ctx, address as string);
      if (mailbox.primaryAddress !== normalizeAddress(address as string)) {
        throw new UserError(`${address} is an alias; give the mailbox's address, ${mailbox.primaryAddress}`);
      }
      const plan = await planMailboxDeletion(ctx, mailbox.mailboxId);
      const summary = `${plan.addresses.length} address(es), ${plan.members.length} member(s), ${((mailbox.usedBytes ?? 0) / 1048576).toFixed(1)} MB of mail`;
      if (!values.yes) {
        throw new UserError(
          `this permanently deletes ${mailbox.primaryAddress}: ${summary}. Add --yes to go ahead.`,
        );
      }
      await deleteMailbox(ctx, plan, `cli:${process.env.USER ?? "unknown"}`);
      await enqueuePurge(
        { sqs: new SQSClient({}), name: process.env.SESAME_NAME ?? "sesame" },
        mailbox.mailboxId,
      );
      console.log(`deleted ${mailbox.primaryAddress} (${summary}); its mail is being purged`);
      return;
    }
    case "alias add": {
      const [alias, target] = need(2);
      await addAlias(ctx, alias as string, target as string);
      console.log(`added alias ${alias} → ${target}`);
      return;
    }
    case "alias remove": {
      const [alias] = need(1);
      await removeAlias(ctx, alias as string);
      console.log(`removed alias ${alias}`);
      return;
    }
    case "alias list": {
      const rows = (await listByType<AddressItem>(ctx, "address")).filter((a) => a.kind === "alias");
      const mailboxes = new Map(
        (await listByType<MailboxItem>(ctx, "mailbox")).map((m) => [m.mailboxId, m.primaryAddress]),
      );
      table(
        ["alias", "mailbox"],
        rows.map((a) => [a.address, mailboxes.get(a.mailboxId) ?? a.mailboxId]),
      );
      return;
    }
    case "member grant": {
      const [mailbox, user] = need(2);
      if (values.role !== "owner" && values.role !== "delegate")
        throw new UserError("--role must be owner or delegate");
      await grantMember(ctx, mailbox as string, user as string, values.role);
      console.log(`granted ${values.role} on ${mailbox} to ${user}`);
      return;
    }
    case "member revoke": {
      const [mailbox, user] = need(2);
      await revokeMember(ctx, mailbox as string, user as string);
      console.log(`revoked ${user} from ${mailbox}`);
      return;
    }
    case "member list": {
      const rows = await listByType<MemberItem>(ctx, "member");
      const mailboxes = new Map(
        (await listByType<MailboxItem>(ctx, "mailbox")).map((m) => [m.mailboxId, m.primaryAddress]),
      );
      table(
        ["mailbox", "user", "role"],
        rows.map((m) => [mailboxes.get(m.mailboxId) ?? m.mailboxId, m.userId, m.role]),
      );
      return;
    }
    case "search reindex": {
      const bucket = process.env.SESAME_MAIL_BUCKET;
      if (!bucket) throw new UserError("set SESAME_MAIL_BUCKET (terraform output mail_bucket)");
      const rctx: ReindexCtx = {
        doc: ctx.doc,
        s3: new S3Client({}),
        mailTable: process.env.SESAME_MAIL_TABLE ?? "sesame-mail",
        mailBucket: bucket,
        indexBody: !values["no-body"],
      };
      let mailboxes = await listByType<MailboxItem>(ctx, "mailbox");
      if (args[0]) {
        const wanted = args[0].toLowerCase();
        mailboxes = mailboxes.filter((m) => m.primaryAddress === wanted);
        if (mailboxes.length === 0) throw new UserError(`no mailbox with address ${args[0]}`);
      }
      for (const m of mailboxes) {
        const count = await reindexMailbox(rctx, m.mailboxId);
        console.log(`reindexed ${count} message(s) in ${m.primaryAddress}`);
      }
      return;
    }
    case "queue status":
    case "queue peek":
    case "queue redrive": {
      const qctx: QueueCtx = { sqs: new SQSClient({}), name: process.env.SESAME_NAME ?? "sesame" };
      if (verb === "status") {
        table(
          ["pipeline", "queued", "in flight", "dead"],
          (await queueStatus(qctx)).map((s) => [
            s.pipeline,
            String(s.queued),
            String(s.inFlight),
            String(s.dead),
          ]),
        );
        return;
      }
      const [pipeline] = need(1);
      if (!isPipeline(pipeline))
        throw new UserError(`pipeline must be one of ${Object.keys(PIPELINES).join(", ")}`);
      if (verb === "peek") {
        const dead = await peekDead(qctx, pipeline);
        if (values.json) {
          for (const m of dead) console.log(m.body);
          return;
        }
        table(
          ["sent", "receives", "message"],
          dead.map((m) => [m.sentAt, String(m.receiveCount), m.summary]),
        );
        return;
      }
      const r = await redrive(qctx, pipeline);
      console.log(
        r.moved === 0
          ? `${r.from} is empty`
          : `moving about ${r.moved} message(s) from ${r.from} back to ${r.to}; check "queue status" in a minute`,
      );
      return;
    }
    default:
      throw new UserError(`unknown command "${positionals.join(" ")}"\n\n${USAGE}`);
  }
}

function table(header: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  console.log(line(header));
  for (const r of rows) console.log(line(r));
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof UserError || (err instanceof Error && err.message.startsWith("invalid "))) {
    console.error(`sesame: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
