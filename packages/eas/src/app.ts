// The ActiveSync endpoint: OPTIONS and POST on /Microsoft-Server-ActiveSync.
// Every request signs in with Basic auth; every command but Provision needs the device's
// policy key; bodies are WBXML both ways.
import { createHash } from "node:crypto";
import { type Context, Hono } from "hono";
import { authenticate } from "./auth.ts";
import { folderSync } from "./commands/folderSync.ts";
import { getItemEstimate } from "./commands/getItemEstimate.ts";
import { itemOperations } from "./commands/itemOperations.ts";
import { moveItems } from "./commands/moveItems.ts";
import { provision } from "./commands/provision.ts";
import { sendMail, smartForward, smartReply } from "./commands/sendMail.ts";
import { settings } from "./commands/settings.ts";
import { sync } from "./commands/sync.ts";
import { createDeps, type Deps, log } from "./deps.ts";
import {
  GlobalStatus,
  type Handler,
  MULTIPART_TYPE,
  type MultipartReply,
  PROTOCOL_VERSION,
  WBXML_TYPE,
} from "./protocol.ts";
import { parseRequest, RequestError } from "./request.ts";
import { decode, type Element, el, encode, WbxmlError } from "./wbxml/codec.ts";

const PATH = "/microsoft-server-activesync";
/** Larger than any message SES can send (40 MB) once base64 has grown it in WBXML. */
const MAX_BODY_BYTES = 60 * 1024 * 1024;

interface Command {
  /** Root element and its Status child, for answering with a global status such as 142. */
  root: string;
  status: string;
  run?: Handler;
}

/** Every command iOS may send. Those with a handler are advertised in OPTIONS. */
const COMMANDS: Record<string, Command> = {
  Provision: { root: "Provision:Provision", status: "Provision:Status", run: provision },
  Settings: { root: "Settings:Settings", status: "Settings:Status", run: settings },
  FolderSync: { root: "FolderHierarchy:FolderSync", status: "FolderHierarchy:Status", run: folderSync },
  Sync: { root: "AirSync:Sync", status: "AirSync:Status", run: sync },
  GetItemEstimate: {
    root: "GetItemEstimate:GetItemEstimate",
    status: "GetItemEstimate:Status",
    run: getItemEstimate,
  },
  ItemOperations: {
    root: "ItemOperations:ItemOperations",
    status: "ItemOperations:Status",
    run: itemOperations,
  },
  MoveItems: { root: "Move:MoveItems", status: "Move:Status", run: moveItems },
  SendMail: { root: "ComposeMail:SendMail", status: "ComposeMail:Status", run: sendMail },
  SmartReply: { root: "ComposeMail:SmartReply", status: "ComposeMail:Status", run: smartReply },
  SmartForward: { root: "ComposeMail:SmartForward", status: "ComposeMail:Status", run: smartForward },
  Ping: { root: "Ping:Ping", status: "Ping:Status" },
};

export const advertisedCommands = () =>
  Object.entries(COMMANDS)
    .filter(([, c]) => c.run)
    .map(([name]) => name);

export function createApp(loadDeps: () => Promise<Deps>) {
  let pending: Promise<Deps> | undefined;
  const app = new Hono();

  app.all("*", async (c) => {
    if (c.req.path.toLowerCase() !== PATH) return c.text("Not Found", 404);
    pending ??= loadDeps().catch((err) => {
      pending = undefined;
      throw err;
    });
    const deps = await pending;
    const started = deps.now();
    c.header("MS-Server-ActiveSync", PROTOCOL_VERSION);
    c.header("Cache-Control", "private, no-store");

    if (c.req.method === "OPTIONS") {
      const session = await authenticate(deps, {
        authorization: c.req.header("authorization"),
        ip: clientIp(c),
      });
      if (!session) return unauthorized(c);
      c.header("MS-ASProtocolVersions", PROTOCOL_VERSION);
      c.header("MS-ASProtocolCommands", advertisedCommands().join(","));
      c.header("Allow", "OPTIONS,POST");
      c.header("Public", "OPTIONS,POST");
      return c.body(null, 200);
    }
    if (c.req.method !== "POST") return c.text("Method Not Allowed", 405, { Allow: "OPTIONS,POST" });

    let req: ReturnType<typeof parseRequest>;
    try {
      req = parseRequest(new URL(c.req.url).search, (name) => c.req.header(name));
    } catch (err) {
      if (err instanceof RequestError) return c.text(err.message, 400);
      throw err;
    }
    const fields = { cmd: req.cmd, device: hashId(req.deviceId), deviceType: req.deviceType };
    if (req.protocolVersion && req.protocolVersion !== PROTOCOL_VERSION) {
      c.header("MS-ASProtocolVersions", PROTOCOL_VERSION);
      return c.text("Unsupported protocol version", 400);
    }

    const device = { deviceId: req.deviceId, deviceType: req.deviceType };
    const userAgent = c.req.header("user-agent");
    const session = await authenticate(deps, {
      authorization: c.req.header("authorization"),
      ip: clientIp(c),
      device: userAgent ? { ...device, userAgent } : device,
    });
    if (!session?.device) return unauthorized(c);

    const command = COMMANDS[req.cmd];
    if (!command?.run) {
      deps.log("warn", "ActiveSync command not implemented", fields);
      return c.text("Not Implemented", 501);
    }

    const raw = Buffer.from(await c.req.arrayBuffer());
    if (raw.length > MAX_BODY_BYTES) return c.text("Request Entity Too Large", 413);
    let body: Element | undefined;
    try {
      body = raw.length ? decode(raw) : undefined;
    } catch (err) {
      if (!(err instanceof WbxmlError)) throw err;
      deps.log("warn", "ActiveSync request is not valid WBXML", { ...fields, error: err.message });
      return wbxml(c, el(command.root, [el(command.status, GlobalStatus.InvalidWbxml)]));
    }

    if (req.cmd !== "Provision") {
      const expected = session.device.policyKey;
      if (!expected || req.policyKey !== expected) {
        const status =
          !expected || !req.policyKey || req.policyKey === "0"
            ? GlobalStatus.DeviceNotProvisioned
            : GlobalStatus.InvalidPolicyKey;
        deps.log("info", "ActiveSync device must provision", { ...fields, status });
        return wbxml(c, el(command.root, [el(command.status, status)]));
      }
    }

    const response = await command.run({ deps, req, session: { ...session, device: session.device } }, body);
    deps.log("info", "ActiveSync request", { ...fields, ms: deps.now() - started });
    if (response === null) return c.body(null, 200);
    return "parts" in response ? multipart(c, response) : wbxml(c, response);
  });

  app.onError((err, c) => {
    log("error", "unhandled ActiveSync error", { error: String(err) });
    return c.text("Internal Server Error", 500);
  });
  return app;
}

function wbxml(c: Context, root: Element) {
  return c.body(new Uint8Array(encode(root)), 200, { "Content-Type": WBXML_TYPE });
}

/** Part count, then each part's offset and length (little-endian int32s), then the parts. */
function multipart(c: Context, reply: MultipartReply) {
  const parts = [encode(reply.root), ...reply.parts];
  const header = Buffer.alloc(4 + 8 * parts.length);
  header.writeInt32LE(parts.length, 0);
  let offset = header.length;
  parts.forEach((part, i) => {
    header.writeInt32LE(offset, 4 + 8 * i);
    header.writeInt32LE(part.length, 8 + 8 * i);
    offset += part.length;
  });
  return c.body(new Uint8Array(Buffer.concat([header, ...parts])), 200, { "Content-Type": MULTIPART_TYPE });
}

function unauthorized(c: Context) {
  return c.body(null, 401, { "WWW-Authenticate": 'Basic realm="sesame"' });
}

/** The first X-Forwarded-For hop, which the Web Function front end sets to the client. */
function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** Device ids are stable identifiers, so logs carry a short hash instead. */
function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

export const app = createApp(createDeps);
