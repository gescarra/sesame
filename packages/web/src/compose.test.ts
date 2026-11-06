import type { MessageDetail } from "@sesame/core/dto";
import { describe, expect, it } from "vitest";
import { draftFrom, parseAddressList, prefixSubject } from "./compose.ts";

const message: MessageDetail = {
  id: "M1",
  threadId: "M1",
  folder: "inbox",
  from: { name: "Bob", address: "bob@example.org" },
  to: [{ name: "Alice", address: "alice@example.com" }, { address: "carol@example.net" }],
  cc: [{ address: "dan@example.net" }, { address: "Bob@example.org" }],
  subject: "Plans",
  snippet: "",
  date: "2026-10-28T10:00:00Z",
  receivedAt: "2026-10-28T10:00:00Z",
  size: 1,
  read: true,
  flagged: false,
  hasAttachments: true,
  attachments: [
    { partId: "0", filename: "logo.png", contentType: "image/png", size: 5, inline: true, contentId: "l" },
    { partId: "1", filename: "plan.pdf", contentType: "application/pdf", size: 900, inline: false },
  ],
};

describe("parseAddressList", () => {
  it("accepts bare and named addresses with any separator", () => {
    expect(parseAddressList("a@x.test, Bob <B@Y.test>; c@z.test\nmailto:d@w.test")).toEqual({
      addresses: ["a@x.test", "b@y.test", "c@z.test", "d@w.test"],
      invalid: [],
    });
  });

  it("reports what it can't parse and drops duplicates", () => {
    expect(parseAddressList("a@x.test, nope, A@x.test, , bob@")).toEqual({
      addresses: ["a@x.test"],
      invalid: ["nope", "bob@"],
    });
  });
});

describe("prefixSubject", () => {
  it("adds a prefix once", () => {
    expect(prefixSubject("Re", "Plans")).toBe("Re: Plans");
    expect(prefixSubject("Re", "RE: Plans")).toBe("RE: Plans");
    expect(prefixSubject("Fwd", "Fw: Plans")).toBe("Fw: Plans");
    expect(prefixSubject("Re", "")).toBe("Re:");
  });
});

describe("draftFrom", () => {
  it("replies to the sender, or to Reply-To when set", () => {
    const d = draftFrom("reply", message, "Hi\n> earlier", ["alice@example.com"]);
    expect(d).toMatchObject({ to: "Bob <bob@example.org>", cc: "", subject: "Re: Plans", inReplyTo: "M1" });
    expect(d.text).toMatch(/wrote:\n> Hi\n>> earlier\n$/);
    const viaReplyTo = draftFrom("reply", { ...message, replyTo: [{ address: "list@example.org" }] }, "", []);
    expect(viaReplyTo.to).toBe("list@example.org");
  });

  it("replies to everyone except yourself, without duplicates", () => {
    const d = draftFrom("replyAll", message, "", ["alice@example.com"]);
    expect(d.to).toBe("Bob <bob@example.org>");
    expect(d.cc).toBe("carol@example.net, dan@example.net");
  });

  it("replying to your own sent message goes to its recipients", () => {
    const sent = {
      ...message,
      from: { address: "alice@example.com" },
      to: [{ address: "x@ext.test" }],
      cc: [],
    };
    expect(draftFrom("reply", sent, "", ["alice@example.com"]).to).toBe("x@ext.test");
  });

  it("forwards with the original's headers and its non-inline attachments", () => {
    const d = draftFrom("forward", message, "Body text", []);
    expect(d).toMatchObject({
      to: "",
      subject: "Fwd: Plans",
      forward: { id: "M1", parts: [{ partId: "1", filename: "plan.pdf", size: 900 }] },
    });
    expect(d.text).toContain("---------- Forwarded message ---------\nFrom: Bob <bob@example.org>");
    expect(d.text).toContain("Cc: dan@example.net, Bob@example.org");
    expect(d.text).toContain("Body text");
    expect(d.inReplyTo).toBeUndefined();
  });
});
