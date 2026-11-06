// Directory administration, shared by the CLI and the admin console. Each command writes the
// directory table directly.
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  paginateScan,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  type AddressItem,
  type DomainItem,
  directoryKeys,
  domainOf,
  getItem,
  type MailboxItem,
  type MemberItem,
  newUlid,
  normalizeAddress,
  normalizeDomain,
  type PurgeItem,
  type SuppressionItem,
} from "@sesame/core";

export interface Ctx {
  doc: DynamoDBDocumentClient;
  table: string;
}

export class UserError extends Error {}

const now = () => new Date().toISOString();

export async function addDomain(ctx: Ctx, input: string): Promise<DomainItem> {
  const domain = normalizeDomain(input);
  const item: DomainItem = { ...directoryKeys.domain(domain), type: "domain", domain, createdAt: now() };
  await guarded(
    () =>
      ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: ctx.table, Item: item, ConditionExpression: "attribute_not_exists(pk)" } },
          ],
        }),
      ),
    [`domain ${domain} already exists`],
  );
  return item;
}

export async function setCatchAll(ctx: Ctx, domainInput: string, address: string | null): Promise<void> {
  const domain = normalizeDomain(domainInput);
  if (address === null) {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.table,
        Key: directoryKeys.domain(domain),
        UpdateExpression: "REMOVE catchAllMailboxId",
        ConditionExpression: "attribute_exists(pk)",
      }),
    );
    return;
  }
  const target = await requireAddress(ctx, address);
  if (domainOf(target.address) !== domain) {
    throw new UserError(`catch-all mailbox must be at ${domain}`);
  }
  await ctx.doc.send(
    new UpdateCommand({
      TableName: ctx.table,
      Key: directoryKeys.domain(domain),
      UpdateExpression: "SET catchAllMailboxId = :m",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":m": target.mailboxId },
    }),
  );
}

export interface AddMailboxOptions {
  displayName?: string;
  quotaMb?: number;
  /** Login email of the owner. Defaults to the mailbox address itself. */
  owner?: string;
}

export async function addMailbox(
  ctx: Ctx,
  input: string,
  opts: AddMailboxOptions = {},
): Promise<MailboxItem> {
  const address = normalizeAddress(input);
  const mailboxId = newUlid();
  const createdAt = now();
  const mailbox: MailboxItem = {
    ...directoryKeys.mailbox(mailboxId),
    type: "mailbox",
    mailboxId,
    primaryAddress: address,
    usedBytes: 0,
    createdAt,
  };
  if (opts.displayName) mailbox.displayName = opts.displayName;
  if (opts.quotaMb) mailbox.quotaBytes = opts.quotaMb * 1024 * 1024;
  const addr: AddressItem = {
    ...directoryKeys.address(address),
    type: "address",
    address,
    mailboxId,
    kind: "primary",
    createdAt,
  };
  const owner = normalizeAddress(opts.owner ?? address);
  const member: MemberItem = {
    ...directoryKeys.member(mailboxId, owner),
    type: "member",
    mailboxId,
    userId: owner,
    role: "owner",
    createdAt,
  };

  await guarded(
    () =>
      ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: ctx.table,
                Key: directoryKeys.domain(domainOf(address)),
                ConditionExpression: "attribute_exists(pk)",
              },
            },
            { Put: { TableName: ctx.table, Item: addr, ConditionExpression: "attribute_not_exists(pk)" } },
            { Put: { TableName: ctx.table, Item: mailbox, ConditionExpression: "attribute_not_exists(pk)" } },
            { Put: { TableName: ctx.table, Item: member } },
          ],
        }),
      ),
    [
      `domain ${domainOf(address)} is not in the directory; run "sesame domain add" first`,
      `${address} is already in use`,
      null,
      null,
    ],
  );
  return mailbox;
}

export async function addAlias(ctx: Ctx, aliasInput: string, mailboxAddress: string): Promise<AddressItem> {
  const alias = normalizeAddress(aliasInput);
  const target = await requireAddress(ctx, mailboxAddress);
  const item: AddressItem = {
    ...directoryKeys.address(alias),
    type: "address",
    address: alias,
    mailboxId: target.mailboxId,
    kind: "alias",
    createdAt: now(),
  };
  await guarded(
    () =>
      ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: ctx.table,
                Key: directoryKeys.domain(domainOf(alias)),
                ConditionExpression: "attribute_exists(pk)",
              },
            },
            { Put: { TableName: ctx.table, Item: item, ConditionExpression: "attribute_not_exists(pk)" } },
          ],
        }),
      ),
    [`domain ${domainOf(alias)} is not in the directory`, `${alias} is already in use`],
  );
  return item;
}

export async function removeAlias(ctx: Ctx, aliasInput: string): Promise<void> {
  const alias = normalizeAddress(aliasInput);
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.table,
        Key: directoryKeys.address(alias),
        ConditionExpression: "kind = :alias",
        ExpressionAttributeValues: { ":alias": "alias" },
      }),
    );
  } catch (err) {
    if ((err as Error).name === "ConditionalCheckFailedException") {
      throw new UserError(`${alias} is not an alias`);
    }
    throw err;
  }
}

export async function grantMember(
  ctx: Ctx,
  mailboxAddress: string,
  userId: string,
  role: MemberItem["role"],
): Promise<MemberItem> {
  const target = await requireAddress(ctx, mailboxAddress);
  const user = normalizeAddress(userId);
  const item: MemberItem = {
    ...directoryKeys.member(target.mailboxId, user),
    type: "member",
    mailboxId: target.mailboxId,
    userId: user,
    role,
    createdAt: now(),
  };
  await ctx.doc.send(
    new TransactWriteCommand({ TransactItems: [{ Put: { TableName: ctx.table, Item: item } }] }),
  );
  return item;
}

export async function revokeMember(ctx: Ctx, mailboxAddress: string, userId: string): Promise<void> {
  const target = await requireAddress(ctx, mailboxAddress);
  const { pk, sk } = directoryKeys.member(target.mailboxId, userId);
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.table, Key: { pk, sk } }));
}

/** Admin listings scan the whole table; fine for directory-sized data. */
export async function listByType<T>(ctx: Ctx, type: string): Promise<T[]> {
  const out: T[] = [];
  const pages = paginateScan(
    { client: ctx.doc },
    {
      TableName: ctx.table,
      FilterExpression: "#type = :type",
      ExpressionAttributeNames: { "#type": "type" },
      ExpressionAttributeValues: { ":type": type },
    },
  );
  for await (const page of pages) out.push(...((page.Items ?? []) as T[]));
  return out;
}

/** The mailbox an address (primary or alias) belongs to. */
export async function mailboxByAddress(ctx: Ctx, address: string): Promise<MailboxItem> {
  const target = await requireAddress(ctx, address);
  const mailbox = await getItem<MailboxItem>(ctx.doc, ctx.table, directoryKeys.mailbox(target.mailboxId));
  if (!mailbox) throw new UserError(`${normalizeAddress(address)} points at a mailbox that no longer exists`);
  return mailbox;
}

export async function listSuppressions(ctx: Ctx): Promise<SuppressionItem[]> {
  const items = await listByType<SuppressionItem>(ctx, "suppression");
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

/** Lets mail go to an address again after a bounce or complaint. */
export async function removeSuppression(ctx: Ctx, address: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.table, Key: directoryKeys.suppression(address) }));
}

/** Everything in the directory that deleting a mailbox removes or changes. */
export interface MailboxDeletion {
  mailbox: MailboxItem;
  /** Its primary address and aliases. */
  addresses: AddressItem[];
  members: MemberItem[];
  /** Domains whose catch-all is this mailbox. */
  catchAllDomains: string[];
}

export async function planMailboxDeletion(ctx: Ctx, mailboxId: string): Promise<MailboxDeletion> {
  const mailbox = await getItem<MailboxItem>(ctx.doc, ctx.table, directoryKeys.mailbox(mailboxId));
  if (!mailbox) throw new UserError("That mailbox doesn't exist.");
  const [addresses, members, domains] = await Promise.all([
    listByType<AddressItem>(ctx, "address"),
    listByType<MemberItem>(ctx, "member"),
    listByType<DomainItem>(ctx, "domain"),
  ]);
  return {
    mailbox,
    addresses: addresses.filter((a) => a.mailboxId === mailboxId),
    members: members.filter((m) => m.mailboxId === mailboxId),
    catchAllDomains: domains.filter((d) => d.catchAllMailboxId === mailboxId).map((d) => d.domain),
  };
}

/**
 * Removes a mailbox from the directory in one transaction: its addresses, members and catch-all
 * settings go, so it stops receiving mail and nobody can open it. A purge marker records that
 * its mail still has to be deleted, which the purge Lambda does (see enqueuePurge).
 */
export async function deleteMailbox(
  ctx: Ctx,
  plan: MailboxDeletion,
  requestedBy: string,
  now = Date.now(),
): Promise<PurgeItem> {
  const { mailbox } = plan;
  const id = mailbox.mailboxId;
  const marker: PurgeItem = {
    ...directoryKeys.purge(id),
    type: "purge",
    mailboxId: id,
    address: mailbox.primaryAddress,
    requestedBy,
    requestedAt: new Date(now).toISOString(),
  };
  const items = [
    {
      Delete: {
        TableName: ctx.table,
        Key: directoryKeys.mailbox(id),
        ConditionExpression: "attribute_exists(pk)",
      },
    },
    ...plan.addresses.map((a) => ({
      Delete: {
        TableName: ctx.table,
        Key: directoryKeys.address(a.address),
        ConditionExpression: "mailboxId = :id",
        ExpressionAttributeValues: { ":id": id },
      },
    })),
    ...plan.members.map((m) => ({
      Delete: { TableName: ctx.table, Key: { pk: m.pk, sk: m.sk } },
    })),
    ...plan.catchAllDomains.map((d) => ({
      Update: {
        TableName: ctx.table,
        Key: directoryKeys.domain(d),
        UpdateExpression: "REMOVE catchAllMailboxId",
        ConditionExpression: "catchAllMailboxId = :id",
        ExpressionAttributeValues: { ":id": id },
      },
    })),
    { Put: { TableName: ctx.table, Item: marker } },
  ];
  // DynamoDB transactions take at most 100 items.
  if (items.length > 100) {
    throw new UserError(
      `This mailbox has ${plan.addresses.length - 1} aliases and ${plan.members.length} members; remove some first.`,
    );
  }
  try {
    await ctx.doc.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      throw new UserError("The mailbox changed while it was being deleted. Try again.");
    }
    throw err;
  }
  return marker;
}

export async function listPendingPurges(ctx: Ctx): Promise<PurgeItem[]> {
  const items = await listByType<PurgeItem>(ctx, "purge");
  return items.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

async function requireAddress(ctx: Ctx, input: string): Promise<AddressItem> {
  const address = normalizeAddress(input);
  const item = await getItem<AddressItem>(ctx.doc, ctx.table, directoryKeys.address(address));
  if (!item) throw new UserError(`${address} is not a mailbox address or alias`);
  return item;
}

/**
 * Runs a transaction and turns condition failures into readable errors.
 * messages[i] explains a failed condition on TransactItems[i]; null for items without one.
 */
async function guarded(fn: () => Promise<unknown>, messages: (string | null)[]): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      const reasons = err.CancellationReasons ?? [];
      const failed = reasons.findIndex((r) => r.Code === "ConditionalCheckFailed");
      const message = failed >= 0 ? messages[failed] : null;
      if (message) throw new UserError(message);
    }
    throw err;
  }
}

/** Sets a mailbox's quota in MB, or removes it with null. Returns the mailbox as updated. */
export async function setQuota(
  ctx: Ctx,
  mailboxAddress: string,
  quotaMb: number | null,
): Promise<MailboxItem> {
  const target = await requireAddress(ctx, mailboxAddress);
  const res = await ctx.doc.send(
    new UpdateCommand({
      TableName: ctx.table,
      Key: directoryKeys.mailbox(target.mailboxId),
      UpdateExpression: quotaMb === null ? "REMOVE quotaBytes" : "SET quotaBytes = :q",
      ConditionExpression: "attribute_exists(pk)",
      ...(quotaMb === null ? {} : { ExpressionAttributeValues: { ":q": Math.round(quotaMb * 1024 * 1024) } }),
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes as MailboxItem;
}
