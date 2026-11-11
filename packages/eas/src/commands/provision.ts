// Provision ([MS-ASPROV]): two rounds. The client asks for the policy and gets it with a
// temporary key; it acknowledges with that key and gets the final one, which every later
// request carries in X-MS-PolicyKey. sesame's policy asks for nothing: no passcode rules,
// no encryption requirement.
import { randomInt } from "node:crypto";
import { updateDevice } from "../auth.ts";
import type { Handler } from "../protocol.ts";
import { child, childText, type Element, el } from "../wbxml/codec.ts";
import { deviceInformation } from "./settings.ts";

const POLICY_TYPE = "MS-EAS-Provisioning-WBXML";

const Status = { Success: 1, ProtocolError: 2 } as const;
const PolicyStatus = { Success: 1, UnknownType: 3, WrongKey: 5 } as const;

/** A random non-zero 32-bit key, as a decimal string. */
export function newPolicyKey(): string {
  return String(randomInt(1, 2 ** 32 - 1));
}

/** Everything allowed, nothing required. */
const POLICY = el("Provision:EASProvisionDoc", [
  el("Provision:DevicePasswordEnabled", 0),
  el("Provision:AlphanumericDevicePasswordRequired", 0),
  el("Provision:PasswordRecoveryEnabled", 0),
  el("Provision:RequireStorageCardEncryption", 0),
  el("Provision:AttachmentsEnabled", 1),
  el("Provision:AllowSimpleDevicePassword", 1),
  el("Provision:AllowStorageCard", 1),
  el("Provision:AllowCamera", 1),
  el("Provision:RequireDeviceEncryption", 0),
  el("Provision:AllowWiFi", 1),
  el("Provision:AllowTextMessaging", 1),
  el("Provision:AllowPOPIMAPEmail", 1),
  el("Provision:AllowBluetooth", 2),
  el("Provision:AllowIrDA", 1),
  el("Provision:RequireManualSyncWhenRoaming", 0),
  el("Provision:AllowDesktopSync", 1),
  el("Provision:MaxCalendarAgeFilter", 0),
  el("Provision:AllowHTMLEmail", 1),
  el("Provision:MaxEmailAgeFilter", 0),
  el("Provision:AllowBrowser", 1),
  el("Provision:AllowConsumerEmail", 1),
  el("Provision:AllowRemoteDesktop", 1),
  el("Provision:AllowInternetSharing", 1),
]);

export const provision: Handler = async (ctx, body) => {
  const out: Element[] = [];
  let device = ctx.session.device;

  const info = child(body, "Settings:DeviceInformation");
  if (info) {
    const result = await deviceInformation(ctx, info);
    device = result.device;
    out.push(result.response);
  }

  // sesame never asks for a wipe; acknowledge one if a client reports it anyway.
  if (child(body, "Provision:RemoteWipe")) {
    return el("Provision:Provision", [...out, el("Provision:Status", Status.Success)]);
  }

  const policy = child(child(body, "Provision:Policies"), "Provision:Policy");
  if (!policy) return el("Provision:Provision", [...out, el("Provision:Status", Status.ProtocolError)]);
  const type = childText(policy, "Provision:PolicyType");
  if (type !== POLICY_TYPE) {
    return el("Provision:Provision", [
      ...out,
      el("Provision:Status", Status.Success),
      policies(type ?? "", PolicyStatus.UnknownType),
    ]);
  }

  const ackKey = childText(policy, "Provision:PolicyKey");
  if (ackKey === undefined) {
    // Round one: hand out the policy and a temporary key.
    const pending = newPolicyKey();
    await updateDevice(ctx.deps, device, { pendingPolicyKey: pending });
    ctx.deps.log("info", "ActiveSync provisioning started", { device: ctx.session.device.deviceType });
    return el("Provision:Provision", [
      ...out,
      el("Provision:Status", Status.Success),
      policies(POLICY_TYPE, PolicyStatus.Success, pending, el("Provision:Data", [POLICY])),
    ]);
  }

  // Round two: the client acknowledges the temporary key (or repeats the final one).
  if (ackKey !== device.pendingPolicyKey && ackKey !== device.policyKey) {
    return el("Provision:Provision", [
      ...out,
      el("Provision:Status", Status.Success),
      policies(POLICY_TYPE, PolicyStatus.WrongKey),
    ]);
  }
  const final = ackKey === device.policyKey ? ackKey : newPolicyKey();
  await updateDevice(ctx.deps, device, { policyKey: final, pendingPolicyKey: undefined });
  ctx.deps.log("info", "ActiveSync device provisioned", { device: ctx.session.device.deviceType });
  return el("Provision:Provision", [
    ...out,
    el("Provision:Status", Status.Success),
    policies(POLICY_TYPE, PolicyStatus.Success, final),
  ]);
};

function policies(type: string, status: number, key?: string, data?: Element) {
  return el("Provision:Policies", [
    el("Provision:Policy", [
      el("Provision:PolicyType", type),
      el("Provision:Status", status),
      key !== undefined && el("Provision:PolicyKey", key),
      data,
    ]),
  ]);
}
