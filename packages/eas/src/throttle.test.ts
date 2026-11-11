// Failed sign-ins are counted per username and per source IP in 15-minute windows. Past
// MAX_FAILURES, a correct password is still refused for devices the server hasn't seen, so a
// lucky guess gets nothing, while phones that already work keep working.
import { beforeEach, describe, expect, it } from "vitest";
import { clientIp, createApp } from "./app.ts";
import { MAX_FAILURES } from "./auth.ts";
import { autodiscoverResponse, requestedAddress } from "./autodiscover.ts";
import { ALICE, basic, DIR, FakeDb, NOW, PASSWORD, post } from "./testing.ts";
import { el } from "./wbxml/codec.ts";

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  db.seedAlice();
});

const WINDOW_MS = 15 * 60 * 1000;
const folderSync = el("FolderHierarchy:FolderSync", [el("FolderHierarchy:SyncKey", "0")]);

/** HTTP status of a FolderSync: 200 once signed in (an unprovisioned device gets status 142 inside), 401 if refused. */
async function signIn(opts: { user?: string; ip?: string; deviceId?: string } = {}) {
  const { res } = await post(db, "FolderSync", folderSync, {
    auth: basic(opts.user ?? ALICE, PASSWORD),
    ip: opts.ip ?? "198.51.100.1",
    deviceId: opts.deviceId ?? "NEW1",
  });
  return res.status;
}

async function fail(times: number, opts: { user?: string; ip?: (i: number) => string } = {}) {
  for (let i = 0; i < times; i++) {
    await post(db, "FolderSync", undefined, {
      auth: basic(opts.user ?? ALICE, "wrong"),
      ip: opts.ip?.(i) ?? "203.0.113.7",
    });
  }
}

async function options(ip: string) {
  const res = await createApp(async () => db.deps).request("/Microsoft-Server-ActiveSync", {
    method: "OPTIONS",
    headers: { Authorization: basic(ALICE, PASSWORD), "X-Forwarded-For": ip },
  });
  return res.status;
}

describe("sign-in throttling", () => {
  it("still accepts a new device one failure short of the limit", async () => {
    await fail(MAX_FAILURES - 1);
    expect(await signIn({ ip: "203.0.113.7" })).toBe(200);
  });

  it("locks out a source IP whatever usernames it guesses, and only that IP", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await fail(1, { user: `user${i}@example.com` });
    expect(await signIn({ ip: "203.0.113.7" })).toBe(401);
    expect(await signIn({ ip: "198.51.100.1" })).toBe(200);
  });

  it("locks out a username guessed from many IPs", async () => {
    await fail(MAX_FAILURES, { ip: (i) => `203.0.113.${i + 10}` });
    expect(await signIn({ ip: "198.51.100.99" })).toBe(401);
    // Only the counters for that username and those IPs exist; nothing else was touched.
    expect(db.all(DIR, `AUTHFAIL#user:${ALICE}#`)).toHaveLength(1);
  });

  it("lets new devices in again in the next window, and lets counters expire", async () => {
    await fail(MAX_FAILURES);
    expect(await signIn({ ip: "203.0.113.7" })).toBe(401);
    const [counter] = db.all(DIR, `AUTHFAIL#user:${ALICE}#`);
    expect(Number(counter?.ttl) * 1000).toBeGreaterThanOrEqual(NOW + WINDOW_MS);

    db.clock = (Math.floor(NOW / WINDOW_MS) + 1) * WINDOW_MS;
    expect(await signIn({ ip: "203.0.113.7" })).toBe(200);
  });

  it("keeps a phone that already signed in working through a lockout", async () => {
    expect(await signIn({ deviceId: "PHONE1" })).toBe(200);
    await fail(MAX_FAILURES);
    expect(await signIn({ deviceId: "PHONE1", ip: "203.0.113.7" })).toBe(200);
    expect(await signIn({ deviceId: "OTHER2", ip: "203.0.113.7" })).toBe(401);
  });

  it("answers OPTIONS during a lockout only for a password that has signed in before", async () => {
    await fail(MAX_FAILURES);
    // OPTIONS has no DeviceId to recognise; a password never used yet gets nothing.
    expect(await options("203.0.113.7")).toBe(401);

    // Next window: a phone signs in, then someone guesses again; its OPTIONS still work.
    db.clock = (Math.floor(NOW / WINDOW_MS) + 1) * WINDOW_MS;
    expect(await signIn({ deviceId: "PHONE1" })).toBe(200);
    await fail(MAX_FAILURES);
    expect(await options("203.0.113.7")).toBe(200);
  });
});

describe("client address", () => {
  it("comes from CloudFront-Viewer-Address, not the spoofable start of X-Forwarded-For", () => {
    expect(clientIp("203.0.113.7:46532", "10.0.0.1, 203.0.113.7")).toBe("203.0.113.7");
    expect(clientIp("2001:db8::1:46532", undefined)).toBe("2001:db8::1");
    expect(clientIp(undefined, "198.51.100.1, 10.0.0.1")).toBe("198.51.100.1");
    expect(clientIp(undefined, undefined)).toBe("unknown");
  });

  it("counts failures against the viewer address CloudFront reports", async () => {
    const res = await createApp(async () => db.deps).request(
      "/Microsoft-Server-ActiveSync?Cmd=FolderSync&User=alice&DeviceId=X1&DeviceType=iPhone",
      {
        method: "POST",
        headers: {
          Authorization: basic(ALICE, "wrong"),
          "CloudFront-Viewer-Address": "192.0.2.9:51000",
          "X-Forwarded-For": "1.2.3.4",
          "MS-ASProtocolVersion": "14.1",
        },
      },
    );
    expect(res.status).toBe(401);
    expect(db.all(DIR, "AUTHFAIL#ip:192.0.2.9#")).toHaveLength(1);
    expect(db.all(DIR, "AUTHFAIL#ip:1.2.3.4#")).toHaveLength(0);
  });
});

describe("Autodiscover", () => {
  const request = (email: string) =>
    `<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/mobilesync/requestschema/2006"><Request><EMailAddress>${email}</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/mobilesync/responseschema/2006</AcceptableResponseSchema></Request></Autodiscover>`;

  it("answers with this endpoint's URL, without signing in or looking the address up", async () => {
    const res = await createApp(async () => db.deps).request(
      "https://eas.example.com/Autodiscover/Autodiscover.xml",
      { method: "POST", headers: { "Content-Type": "text/xml" }, body: request(ALICE) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const xml = await res.text();
    expect(xml).toContain("<Type>MobileSync</Type>");
    expect(xml).toContain("<Url>https://eas.example.com/Microsoft-Server-ActiveSync</Url>");
    expect(xml).toContain(`<EMailAddress>${ALICE}</EMailAddress>`);
    expect(db.logs).toEqual([]);
  });

  it("names the host the phone asked, which CloudFront passes in X-Forwarded-Host", async () => {
    const res = await createApp(async () => db.deps).request(
      "https://abc123.lambda-web.us-east-1.on.aws/autodiscover/autodiscover.xml",
      { method: "POST", headers: { "X-Forwarded-Host": "mail.example.com" }, body: request(ALICE) },
    );
    expect(await res.text()).toContain("<Url>https://mail.example.com/Microsoft-Server-ActiveSync</Url>");
  });

  it("ignores anything that isn't an address and escapes what it echoes", () => {
    expect(requestedAddress(request("not an address"))).toBeUndefined();
    expect(requestedAddress("<a:EMailAddress> bob@example.com </a:EMailAddress>")).toBe("bob@example.com");
    expect(autodiscoverResponse("h", 'x"&y@example.com')).toContain("x&quot;&amp;y@example.com");
  });

  it("refuses other methods and oversized requests", async () => {
    const app = createApp(async () => db.deps);
    const put = await app.request("/autodiscover/autodiscover.xml", { method: "PUT" });
    expect(put.status).toBe(405);
    const big = await app.request("/autodiscover/autodiscover.xml", {
      method: "POST",
      headers: { "Content-Length": String(1024 * 1024) },
      body: "x".repeat(1024 * 1024),
    });
    expect(big.status).toBe(413);
  });
});
