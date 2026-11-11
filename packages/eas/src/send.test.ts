import {
  type DeliveryJob,
  deterministicUlid,
  directoryKeys,
  type MailboxItem,
  type SendJob,
} from "@sesame/core";
import PostalMime from "postal-mime";
import { beforeEach, describe, expect, it } from "vitest";
import { DIR, FakeDb, INGEST_QUEUE, MBX, NOW, POLICY_KEY, post, SEND_QUEUE } from "./testing.ts";
import { childText, type Element, el } from "./wbxml/codec.ts";

let db: FakeDb;

const MBXB = "01M5ZJ2GVN042RKXX2HW200C0R";
const ORIGINAL = deterministicUlid(NOW - 3_600_000, "original");

beforeEach(() => {
  db = new FakeDb();
  db.seedAlice();
  db.seedDevice();
  db.put(DIR, {
    ...directoryKeys.mailbox(MBXB),
    type: "mailbox",
    mailboxId: MBXB,
    primaryAddress: "bob@example.com",
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  db.put(DIR, {
    ...directoryKeys.address("bob@example.com"),
    type: "address",
    mailboxId: MBXB,
    kind: "primary",
  });
});

const BODY = "Hi there,\r\n\r\nSee you at 5.\r\n";

function mime(headers: Record<string, string>, body = BODY): Buffer {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  return Buffer.from(`${head}\r\n${body}`);
}

const phoneMessage = (extra: Record<string, string> = {}) =>
  mime({
    From: '"Alice A." <alice@example.com>',
    To: "Carol <carol@ext.test>",
    Cc: "bob@example.com",
    Bcc: "dave@ext.test",
    Subject: "Dinner",
    "Message-ID": "<phone-123@iPhone>",
    "MIME-Version": "1.0",
    "Content-Type": "text/plain; charset=utf-8",
    ...extra,
  });

function compose(
  cmd: "SendMail" | "SmartReply" | "SmartForward",
  raw: Buffer,
  opts: { clientId?: string; source?: string; replaceMime?: boolean } = {},
): Element {
  return el(`ComposeMail:${cmd}`, [
    opts.clientId !== "" && el("ComposeMail:ClientId", opts.clientId ?? "client-1"),
    el("ComposeMail:SaveInSentItems"),
    opts.replaceMime && el("ComposeMail:ReplaceMime"),
    opts.source !== undefined &&
      el("ComposeMail:Source", [el("ComposeMail:FolderId", "inbox"), el("ComposeMail:ItemId", opts.source)]),
    el("ComposeMail:Mime", raw),
  ]);
}

const send = (cmd: "SendMail" | "SmartReply" | "SmartForward", body: Element) =>
  post(db, cmd, body, { policyKey: POLICY_KEY });

/** The MIME queueOutgoing stored for the one message sent. */
function stored(): string {
  const keys = [...db.objects.keys()].filter((k) => k.startsWith("raw/outbound/"));
  expect(keys).toHaveLength(1);
  return db.objects.get(keys[0] as string)?.body.toString("latin1") ?? "";
}

const jobs = (queue: string) => db.queued.filter((q) => q.queue === queue).map((q) => q.job);

function seedOriginal() {
  return db.seedMessage(ORIGINAL, {
    subject: "Plans",
    messageIdHeader: "<orig@example.net>",
    references: ["<older@example.net>"],
    attachments: [
      { partId: "2", filename: "menu.pdf", contentType: "application/pdf", size: 10, inline: false },
    ],
    hasAttachments: true,
  });
}

describe("SendMail", () => {
  it("queues the phone's message with Bcc removed and the body untouched, and answers with an empty body", async () => {
    const { res, bytes } = await send("SendMail", compose("SendMail", phoneMessage()));
    expect(res.status).toBe(200);
    expect(bytes.length).toBe(0);

    const raw = stored();
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(raw).not.toContain("phone-123@iPhone");
    expect(raw).toMatch(/^Message-ID: <[0-9a-z]{26}@example\.com>\r$/m);
    expect(raw).toMatch(/^Date: Wed, 11 Nov 2026 12:00:00 GMT\r$/m);
    expect(raw).toContain('From: "Alice A." <alice@example.com>');
    expect(raw.endsWith(`\r\n\r\n${BODY}`)).toBe(true);

    const [ingest] = jobs(INGEST_QUEUE) as unknown as DeliveryJob[];
    expect(ingest?.recipients).toEqual(["bob@example.com"]);
    expect(ingest?.sentCopy?.mailboxId).toBe(MBX);
    // Blind recipients still show in the Sent copy's delivery record.
    expect(Object.keys(ingest?.sentCopy?.delivery.recipients ?? {}).sort()).toEqual([
      "bob@example.com",
      "carol@ext.test",
      "dave@ext.test",
    ]);
    const [external] = jobs(SEND_QUEUE) as unknown as SendJob[];
    expect(external?.from).toBe("alice@example.com");
    expect(external?.destinations.sort()).toEqual(["carol@ext.test", "dave@ext.test"]);
  });

  it("keeps a Date the phone set", async () => {
    await send("SendMail", compose("SendMail", phoneMessage({ Date: "Tue, 10 Nov 2026 08:00:00 -0800" })));
    expect(stored()).toContain("Date: Tue, 10 Nov 2026 08:00:00 -0800");
  });

  it("sends a resend with the same ClientId only once", async () => {
    const first = await send("SendMail", compose("SendMail", phoneMessage()));
    const again = await send("SendMail", compose("SendMail", phoneMessage()));
    expect([first.res.status, again.res.status]).toEqual([200, 200]);
    expect(again.bytes.length).toBe(0);
    expect(jobs(INGEST_QUEUE)).toHaveLength(1);
    expect(db.logs).toContain("info: ActiveSync resend ignored");
    const marker = db.get(DIR, directoryKeys.easSend("alice@example.com", "ABC123", "client-1"));
    expect(marker?.ttl).toBe(NOW / 1000 + 24 * 3600);
  });

  it("sends from the mailbox when the phone's From isn't one of its addresses", async () => {
    await send("SendMail", compose("SendMail", phoneMessage({ From: "Alice <alice@personal.test>" })));
    expect(stored()).toContain('From: "Alice" <alice@example.com>');
    expect((jobs(SEND_QUEUE)[0] as unknown as SendJob).from).toBe("alice@example.com");
  });

  it("refuses unknown local recipients and forgets the ClientId so a fixed resend goes through", async () => {
    const bad = phoneMessage({ To: "nobody@example.com" });
    const { body } = await send("SendMail", compose("SendMail", bad));
    expect(childText(body, "ComposeMail:Status")).toBe("116");
    expect(db.queued).toHaveLength(0);
    expect(db.get(DIR, directoryKeys.easSend("alice@example.com", "ABC123", "client-1"))).toBeUndefined();

    const { res } = await send("SendMail", compose("SendMail", phoneMessage()));
    expect(res.status).toBe(200);
    expect(jobs(INGEST_QUEUE)).toHaveLength(1);
  });

  it("answers 119 when there are no recipients", async () => {
    const raw = mime({ From: "alice@example.com", Subject: "Nobody" });
    const { body } = await send("SendMail", compose("SendMail", raw));
    expect(childText(body, "ComposeMail:Status")).toBe("119");
  });

  it("answers 115 once the hourly send limit is reached", async () => {
    db.put(DIR, { ...directoryKeys.rate("alice@example.com", "2026-11-11T12"), count: 200 });
    const { body } = await send("SendMail", compose("SendMail", phoneMessage()));
    expect(childText(body, "ComposeMail:Status")).toBe("115");
    expect(db.queued).toHaveLength(0);
  });

  it("answers 113 when the sender's mailbox is full", async () => {
    const mailbox = db.get(DIR, directoryKeys.mailbox(MBX)) as unknown as MailboxItem;
    db.put(DIR, { ...mailbox, quotaBytes: 100, usedBytes: 100 });
    const { body } = await send("SendMail", compose("SendMail", phoneMessage()));
    expect(childText(body, "ComposeMail:Status")).toBe("113");
  });

  it("answers 101 without a ClientId and 107 without MIME", async () => {
    const noId = await send("SendMail", compose("SendMail", phoneMessage(), { clientId: "" }));
    expect(childText(noId.body, "ComposeMail:Status")).toBe("101");
    const noMime = await send(
      "SendMail",
      el("ComposeMail:SendMail", [el("ComposeMail:ClientId", "x"), el("ComposeMail:Mime", Buffer.alloc(0))]),
    );
    expect(childText(noMime.body, "ComposeMail:Status")).toBe("107");
  });
});

describe("SmartReply and SmartForward", () => {
  it("threads a complete reply (ReplaceMime) and leaves its body alone", async () => {
    seedOriginal();
    const reply = phoneMessage({ Subject: "Re: Plans" });
    const { res } = await send(
      "SmartReply",
      compose("SmartReply", reply, { source: `inbox:${ORIGINAL}`, replaceMime: true }),
    );
    expect(res.status).toBe(200);
    const raw = stored();
    expect(raw).toContain("In-Reply-To: <orig@example.net>");
    expect(raw).toContain("References: <older@example.net> <orig@example.net>");
    expect(raw.endsWith(`\r\n\r\n${BODY}`)).toBe(true);
  });

  it("adds the original, quoted, under what the user typed", async () => {
    seedOriginal();
    const html = [
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Sounds good.",
      "--b1",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><p>Sounds good.</p></body></html>",
      "--b1--",
      "",
    ].join("\r\n");
    const reply = mime(
      {
        From: "alice@example.com",
        To: "bob@example.net",
        Bcc: "dave@ext.test",
        Subject: "Re: Plans",
        "MIME-Version": "1.0",
        "Content-Type": 'multipart/alternative; boundary="b1"',
      },
      html,
    );
    await send("SmartReply", compose("SmartReply", reply, { source: `inbox:${ORIGINAL}` }));
    const email = await PostalMime.parse(stored());
    expect(email.text).toContain("Sounds good.");
    expect(email.text).toContain("bob@example.net> wrote:");
    expect(email.text).toContain("> Hi Alice.");
    expect(email.html).toMatch(/<p>Sounds good\.<\/p><br><br><div>On .*wrote:<\/div><blockquote[^>]*>/);
    expect(email.html).toMatch(/<\/blockquote><\/body><\/html>/);
    expect(email.inReplyTo).toBe("<orig@example.net>");
    expect(email.bcc).toBeUndefined();
    expect(email.attachments).toHaveLength(0);
    expect((jobs(SEND_QUEUE)[0] as unknown as SendJob).destinations.sort()).toEqual([
      "bob@example.net",
      "dave@ext.test",
    ]);
  });

  it("forwards the original's attachments even when the phone never downloaded them", async () => {
    seedOriginal();
    const fwd = mime({
      From: "alice@example.com",
      To: "carol@ext.test",
      Subject: "Fwd: Plans",
      "Content-Type": "text/plain; charset=utf-8",
    });
    await send("SmartForward", compose("SmartForward", fwd, { source: `inbox:${ORIGINAL}` }));
    const email = await PostalMime.parse(stored());
    expect(email.text).toContain("---------- Forwarded message ----------");
    expect(email.text).toContain("Subject: Plans");
    expect(email.text).toContain("Hi Alice.");
    expect(email.attachments.map((a) => a.filename)).toEqual(["menu.pdf"]);
    expect(email.inReplyTo).toBeUndefined();
  });

  it("answers 150 when the original is gone", async () => {
    const { body } = await send(
      "SmartReply",
      compose("SmartReply", phoneMessage(), { source: `inbox:${ORIGINAL}` }),
    );
    expect(childText(body, "ComposeMail:Status")).toBe("150");
    expect(db.queued).toHaveLength(0);
  });
});
