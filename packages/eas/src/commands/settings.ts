// Settings ([MS-ASCMD] 2.2.1.18): device information in, the user's addresses out.
// Out-of-office isn't supported: Get reports it off, Set is refused.
import { type DeviceItem, directoryKeys, getItem, type MailboxItem } from "@sesame/core";
import { updateDevice } from "../auth.ts";
import type { CommandContext, Handler } from "../protocol.ts";
import { child, childText, type Element, el } from "../wbxml/codec.ts";

const Status = { Success: 1, ProtocolError: 2, DeniedByPolicy: 7 } as const;

const DEVICE_FIELDS = [
  ["Settings:Model", "model"],
  ["Settings:OS", "os"],
  ["Settings:FriendlyName", "friendlyName"],
  ["Settings:UserAgent", "userAgent"],
] as const;

/** Saves what the client tells about itself. Shared with Provision, which can carry the same block. */
export async function deviceInformation(
  ctx: CommandContext,
  info: Element,
): Promise<{ device: DeviceItem; response: Element }> {
  const set = child(info, "Settings:Set");
  const changes: Partial<DeviceItem> = {};
  for (const [tag, field] of DEVICE_FIELDS) {
    const value = childText(set, tag)?.trim().slice(0, 256);
    if (value && value !== ctx.session.device[field]) changes[field] = value;
  }
  const device = await updateDevice(ctx.deps, ctx.session.device, changes);
  ctx.session.device = device;
  return {
    device,
    response: el("Settings:DeviceInformation", [
      el("Settings:Status", set ? Status.Success : Status.ProtocolError),
    ]),
  };
}

export const settings: Handler = async (ctx, body) => {
  const out: Element[] = [el("Settings:Status", Status.Success)];
  for (const request of body?.children ?? []) {
    switch (request.tag) {
      case "Settings:DeviceInformation":
        out.push((await deviceInformation(ctx, request)).response);
        break;
      case "Settings:UserInformation":
        out.push(await userInformation(ctx));
        break;
      case "Settings:Oof":
        out.push(
          child(request, "Settings:Get")
            ? el("Settings:Oof", [
                el("Settings:Status", Status.Success),
                el("Settings:Get", [el("Settings:OofState", 0)]),
              ])
            : el("Settings:Oof", [el("Settings:Status", Status.DeniedByPolicy)]),
        );
        break;
      case "Settings:DevicePassword":
        // Recovery passwords aren't kept: there's no device policy to recover from.
        out.push(el("Settings:DevicePassword", [el("Settings:Status", Status.Success)]));
        break;
      case "Settings:RightsManagementInformation":
        out.push(el("Settings:RightsManagementInformation", [el("Settings:Status", Status.ProtocolError)]));
        break;
    }
  }
  return el("Settings:Settings", out);
};

/** The 14.1 shape: Get > Accounts > Account > EmailAddresses. */
async function userInformation(ctx: CommandContext): Promise<Element> {
  const mailbox = await getItem<MailboxItem>(
    ctx.deps.doc,
    ctx.deps.config.directoryTable,
    directoryKeys.mailbox(ctx.session.mailboxId),
  );
  if (!mailbox) return el("Settings:UserInformation", [el("Settings:Status", Status.ProtocolError)]);
  return el("Settings:UserInformation", [
    el("Settings:Status", Status.Success),
    el("Settings:Get", [
      el("Settings:Accounts", [
        el("Settings:Account", [
          mailbox.displayName ? el("Settings:UserDisplayName", mailbox.displayName) : undefined,
          el("Settings:EmailAddresses", [
            el("Settings:SMTPAddress", mailbox.primaryAddress),
            el("Settings:PrimarySmtpAddress", mailbox.primaryAddress),
          ]),
        ]),
      ]),
    ]),
  ]);
}
