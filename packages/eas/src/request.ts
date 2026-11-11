// The parts of an ActiveSync request that live outside the WBXML body ([MS-ASHTTP] 2.2.1.1).
// The query string comes in a plain form (Cmd=Sync&User=…&DeviceId=…&DeviceType=…) or, from
// some clients, as one base64 blob. iOS uses the plain form.

export interface EasRequest {
  cmd: string;
  /** As the client typed it; sign-in uses the Authorization header, not this. */
  user?: string;
  deviceId: string;
  deviceType: string;
  /** "14.1" */
  protocolVersion?: string;
  policyKey?: string;
  /** Command parameters such as CollectionId, ItemId, SaveInSent and AcceptMultiPart ("T"). */
  params: Record<string, string>;
}

export class RequestError extends Error {}

const DEVICE_ID = /^[A-Za-z0-9]{1,64}$/;
const DEVICE_TYPE = /^[A-Za-z0-9]{1,64}$/;

/** Command codes of the base64 form, [MS-ASHTTP] 2.2.1.1.1.1.2. */
const COMMAND_CODES: Record<number, string> = {
  0: "Sync",
  1: "SendMail",
  2: "SmartForward",
  3: "SmartReply",
  4: "GetAttachment",
  9: "FolderSync",
  10: "FolderCreate",
  11: "FolderDelete",
  12: "FolderUpdate",
  13: "MoveItems",
  14: "GetItemEstimate",
  15: "MeetingResponse",
  16: "Search",
  17: "Settings",
  18: "Ping",
  19: "ItemOperations",
  20: "Provision",
  21: "ResolveRecipients",
  22: "ValidateCert",
};

/** Parameter tags of the base64 form. */
const PARAM_TAGS: Record<number, string> = {
  0: "AttachmentName",
  1: "CollectionId",
  3: "ItemId",
  4: "LongId",
  6: "Occurrence",
  7: "Options",
  8: "User",
};

export function parseRequest(rawQuery: string, header: (name: string) => string | undefined): EasRequest {
  const query = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
  const req = /(^|&)Cmd=/i.test(query) ? parsePlain(query, header) : parseBase64(query);
  if (!DEVICE_ID.test(req.deviceId)) throw new RequestError("DeviceId is missing or malformed");
  if (!DEVICE_TYPE.test(req.deviceType)) throw new RequestError("DeviceType is missing or malformed");
  return req;
}

function parsePlain(query: string, header: (name: string) => string | undefined): EasRequest {
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  const { Cmd: cmd, User: user, DeviceId: deviceId, DeviceType: deviceType, ...rest } = params;
  if (!cmd) throw new RequestError("Cmd is missing");
  const req: EasRequest = { cmd, deviceId: deviceId ?? "", deviceType: deviceType ?? "", params: rest };
  if (user) req.user = user;
  const version = header("ms-asprotocolversion");
  if (version) req.protocolVersion = version;
  const policyKey = header("x-ms-policykey");
  if (policyKey) req.policyKey = policyKey;
  // The plain form asks for multipart ItemOperations responses with a header.
  if (header("ms-asacceptmultipart")?.toUpperCase() === "T") req.params.AcceptMultiPart = "T";
  return req;
}

function parseBase64(query: string): EasRequest {
  const buf = Buffer.from(decodeURIComponent(query), "base64");
  let pos = 0;
  const byte = () => {
    if (pos >= buf.length) throw new RequestError("query string is truncated");
    return buf[pos++] as number;
  };
  const bytes = (n: number) => {
    if (pos + n > buf.length) throw new RequestError("query string is truncated");
    const out = buf.subarray(pos, pos + n);
    pos += n;
    return out;
  };

  const version = byte();
  const cmd = COMMAND_CODES[byte()];
  if (!cmd) throw new RequestError("unknown command code");
  bytes(2); // locale
  const deviceId = bytes(byte()).toString("hex").toUpperCase();
  const policyKeyBytes = bytes(byte());
  const deviceType = bytes(byte()).toString("utf8");

  const params: Record<string, string> = {};
  while (pos < buf.length) {
    const tag = byte();
    const value = bytes(byte());
    const name = PARAM_TAGS[tag];
    if (!name) continue;
    // Options is a bit mask: 0x01 SaveInSent, 0x02 AcceptMultiPart.
    if (name === "Options") {
      const mask = value[0] ?? 0;
      if (mask & 0x01) params.SaveInSent = "T";
      if (mask & 0x02) params.AcceptMultiPart = "T";
    } else {
      params[name] = value.toString("utf8");
    }
  }

  const req: EasRequest = {
    cmd,
    deviceId,
    deviceType,
    protocolVersion: `${Math.floor(version / 10)}.${version % 10}`,
    params,
  };
  if (params.User) {
    req.user = params.User;
    delete params.User;
  }
  if (policyKeyBytes.length === 4) req.policyKey = String(policyKeyBytes.readUInt32LE(0));
  return req;
}
