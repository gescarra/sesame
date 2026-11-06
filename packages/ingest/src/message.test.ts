import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { multipartMessage, sesNotification } from "./fixtures.ts";
import { InvalidJobError, parseJob } from "./job.ts";
import {
  buildBody,
  extractAttachments,
  makeSnippet,
  messageDate,
  parseMessageIds,
  sanitizeBody,
  toAddresses,
} from "./message.ts";

describe("parseJob", () => {
  it("reads envelope, location and verdicts from an SES notification", () => {
    const job = parseJob(JSON.stringify(sesNotification({ recipients: ["a@example.com", "b@example.com"] })));
    expect(job).toEqual({
      source: "ses",
      id: "ses-abc123",
      bucket: "landing",
      key: "raw/inbound/ses-abc123",
      recipients: ["a@example.com", "b@example.com"],
      receivedAt: "2026-10-27T13:15:01.500Z",
      verdicts: { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" },
    });
  });

  it("ignores non-Received notifications", () => {
    expect(parseJob(JSON.stringify({ notificationType: "AMAZON_SES_SETUP_NOTIFICATION" }))).toBeNull();
  });

  it("accepts internal jobs", () => {
    const job = {
      source: "internal",
      id: "i1",
      bucket: "b",
      key: "raw/internal/i1",
      recipients: ["x@example.com"],
      receivedAt: "2026-10-27T13:15:01.500Z",
    };
    expect(parseJob(JSON.stringify(job))).toMatchObject({ ...job });
  });

  it("accepts internal jobs that only file a Sent copy", () => {
    const sentCopy = { mailboxId: "M", delivery: { status: "sending", recipients: {}, updatedAt: "t" } };
    const job = {
      source: "internal",
      id: "i2",
      bucket: "b",
      key: "k",
      recipients: [],
      receivedAt: "t",
      sentCopy,
    };
    expect(parseJob(JSON.stringify(job))?.sentCopy).toEqual(sentCopy);
    expect(() => parseJob(JSON.stringify({ ...job, sentCopy: undefined }))).toThrow(InvalidJobError);
    expect(() => parseJob(JSON.stringify({ ...job, receivedAt: undefined }))).toThrow(InvalidJobError);
  });

  it("rejects malformed bodies", () => {
    expect(() => parseJob("not json")).toThrow(InvalidJobError);
    const n = sesNotification();
    n.receipt.recipients = [];
    expect(() => parseJob(JSON.stringify(n))).toThrow(InvalidJobError);
  });
});

describe("message transforms", async () => {
  const email = await PostalMime.parse(multipartMessage, { attachmentEncoding: "arraybuffer" });

  it("flattens address groups", () => {
    expect(toAddresses(email.to)).toEqual([
      { name: "Alice", address: "alice@example.com" },
      { address: "bob@example.com" },
      { address: "sales@example.com" },
    ]);
  });

  it("collects references with the direct parent last", () => {
    expect(parseMessageIds(email.references, email.inReplyTo)).toEqual([
      "<msg-0@example.com>",
      "<msg-1@example.com>",
    ]);
  });

  it("normalizes the date header and falls back to the receive time", () => {
    expect(messageDate(email.date, "x")).toBe("2026-10-27T13:15:00.000Z");
    expect(messageDate("garbage", "2026-01-01T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z");
  });

  it("builds a whitespace-collapsed snippet", () => {
    expect(makeSnippet(email.text, email.html)).toBe("Hi Alice, The report is attached.");
    expect(makeSnippet(undefined, "<p>Hello <b>there</b></p>")).toBe("Hello there");
  });

  it("sanitizes HTML bodies", () => {
    const html = buildBody(email).html ?? "";
    expect(html).not.toMatch(/script|onclick|javascript:/i);
    expect(html).toContain('src="cid:logo@sender.test"');
    expect(html).toContain('href="https://example.org" target="_blank" rel="noopener noreferrer nofollow"');
    expect(sanitizeBody('<img src="//tracker.test/p.gif">')).not.toContain("tracker.test");
  });

  it("extracts attachments with safe filenames and inline flags", () => {
    const parts = extractAttachments(email.attachments);
    expect(parts.map((p) => p.meta)).toEqual([
      {
        partId: "0",
        filename: "attachment-1.png",
        contentType: "image/png",
        size: 8,
        inline: true,
        contentId: "logo@sender.test",
      },
      { partId: "1", filename: ".._report.pdf", contentType: "application/pdf", size: 9, inline: false },
    ]);
  });
});
