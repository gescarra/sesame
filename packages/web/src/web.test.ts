import type { MessageSummary, Page } from "@sesame/core/dto";
import { type InfiniteData, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { displayName, formatAddress, formatListDate, formatSize } from "./format.ts";
import {
  buildFrameDocument,
  frameCsp,
  hasRemoteImages,
  originsOf,
  referencedContentIds,
  rewriteCids,
} from "./frame.ts";
import { keys, patchLists } from "./queries.ts";

describe("format", () => {
  it("formats names and addresses", () => {
    expect(displayName({ name: " Bob ", address: "bob@example.org" })).toBe("Bob");
    expect(displayName({ address: "bob@example.org" })).toBe("bob@example.org");
    expect(displayName(undefined)).toBe("(unknown sender)");
    expect(formatAddress({ name: "Bob", address: "bob@example.org" })).toBe("Bob <bob@example.org>");
  });

  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(20 * 1024 * 1024)).toBe("20 MB");
  });

  it("shows a time for today and a date otherwise", () => {
    const now = new Date("2026-10-28T15:00:00");
    expect(formatListDate("2026-10-28T09:05:00", now, "en-US")).toMatch(/9:05/);
    expect(formatListDate("2026-03-02T09:05:00", now, "en-US")).toBe("Mar 2");
    expect(formatListDate("2025-03-02T09:05:00", now, "en-US")).toBe("Mar 2, 2025");
    expect(formatListDate("nonsense", now)).toBe("");
  });
});

describe("message frame", () => {
  const html = '<p>Hi</p><img src="cid:logo@x"><img src="https://tracker.test/p.gif"><img src="cid:missing">';
  const images = new Map([["logo@x", "https://mail.s3.amazonaws.com/att/0?sig=1&x=2"]]);

  it("finds and rewrites cid references", () => {
    expect(referencedContentIds(html)).toEqual(["logo@x", "missing"]);
    const out = rewriteCids(html, images);
    expect(out).toContain('src="https://mail.s3.amazonaws.com/att/0?sig=1&amp;x=2"');
    expect(out).toContain('src="cid:missing"');
  });

  it("blocks remote images unless allowed", () => {
    expect(frameCsp({ inlineImages: images, allowRemoteImages: false })).toBe(
      "default-src 'none'; img-src data: https://mail.s3.amazonaws.com; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'",
    );
    expect(frameCsp({ inlineImages: images, allowRemoteImages: true })).toContain("img-src data: https:;");
    expect(hasRemoteImages(html)).toBe(true);
    expect(hasRemoteImages('<div style="background:url(https://t.test/x)">')).toBe(true);
    expect(hasRemoteImages('<img src="cid:a">')).toBe(false);
  });

  it("wraps the body with a CSP and opens links outside the frame", () => {
    const doc = buildFrameDocument(html, { inlineImages: images, allowRemoteImages: false });
    expect(doc).toMatch(/^<!doctype html>/);
    expect(doc).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https://mail.s3.amazonaws.com;`,
    );
    expect(doc).toContain('<base target="_blank">');
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("ignores values that aren't URLs", () => {
    expect(originsOf(["https://a.test/x", "not a url", "https://a.test/y"])).toEqual(["https://a.test"]);
  });
});

describe("patchLists", () => {
  const msg = (id: string, over: Partial<MessageSummary> = {}): MessageSummary => ({
    id,
    threadId: id,
    folder: "inbox",
    to: [],
    cc: [],
    subject: id,
    snippet: "",
    date: "2026-10-28T00:00:00Z",
    receivedAt: "2026-10-28T00:00:00Z",
    size: 1,
    read: false,
    flagged: false,
    hasAttachments: false,
    ...over,
  });
  type Data = InfiniteData<Page<MessageSummary>, string>;
  const seed = (client: QueryClient, key: readonly unknown[], items: MessageSummary[]) =>
    client.setQueryData<Data>(key, { pages: [{ items }], pageParams: [""] });
  const ids = (client: QueryClient, key: readonly unknown[]) =>
    client.getQueryData<Data>(key)?.pages.flatMap((p) => p.items.map((m) => `${m.id}:${m.read ? "r" : "u"}`));

  it("updates, moves out of and deletes from cached lists", () => {
    const client = new QueryClient();
    const inbox = keys.list("M", "inbox", false);
    const unread = keys.list("M", "inbox", true);
    const flagged = keys.list("M", "flagged", false);
    seed(client, inbox, [msg("a"), msg("b"), msg("c")]);
    seed(client, unread, [msg("a"), msg("b")]);
    seed(client, flagged, [msg("c", { flagged: true })]);

    patchLists(client, "M", new Set(["a"]), { read: true });
    expect(ids(client, inbox)).toEqual(["a:r", "b:u", "c:u"]);
    expect(ids(client, unread)).toEqual(["a:r", "b:u"]); // stays until the next refresh

    patchLists(client, "M", new Set(["b"]), { folder: "archive" });
    expect(ids(client, inbox)).toEqual(["a:r", "c:u"]);

    patchLists(client, "M", new Set(["c"]), { flagged: false });
    expect(ids(client, flagged)).toEqual([]);

    patchLists(client, "M", new Set(["a"]), "delete");
    expect(ids(client, inbox)).toEqual(["c:u"]);

    // Search results span folders: moving keeps the message, deleting removes it.
    const search = keys.search("M", "plans");
    seed(client, search, [msg("d"), msg("e")]);
    patchLists(client, "M", new Set(["d"]), { folder: "archive" });
    expect(ids(client, search)).toEqual(["d:u", "e:u"]);
    patchLists(client, "M", new Set(["e"]), "delete");
    expect(ids(client, search)).toEqual(["d:u"]);
  });
});
