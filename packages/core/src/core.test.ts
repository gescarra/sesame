import { describe, expect, it } from "vitest";
import { domainOf, isValidAddress, normalizeAddress, normalizeDomain } from "./address.ts";
import { deterministicUlid, newUlid, ulidTime } from "./ids.ts";
import { directoryKeys, mailKeys, searchShard } from "./keys.ts";

describe("address", () => {
  it("normalizes case, whitespace and angle brackets", () => {
    expect(normalizeAddress("  <Alice@Example.COM> ")).toBe("alice@example.com");
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "alice", "alice@", "@example.com", "a b@example.com", "alice@localhost"]) {
      expect(isValidAddress(bad), bad).toBe(false);
    }
  });

  it("extracts the domain", () => {
    expect(domainOf("Bob@Mail.Example.org")).toBe("mail.example.org");
    expect(normalizeDomain("Example.com.")).toBe("example.com");
  });
});

describe("ids", () => {
  it("encodes time in the first 10 characters", () => {
    const t = Date.UTC(2026, 9, 27, 12, 0, 0);
    const id = newUlid(t);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulidTime(id)).toBe(t);
  });

  it("sorts by time", () => {
    expect(newUlid(1000) < newUlid(2000)).toBe(true);
  });

  it("is deterministic for the same seed", () => {
    const a = deterministicUlid(1000, "ses-1:mbx-a");
    expect(deterministicUlid(1000, "ses-1:mbx-a")).toBe(a);
    expect(deterministicUlid(1000, "ses-1:mbx-b")).not.toBe(a);
  });
});

describe("keys", () => {
  it("normalizes addresses inside keys", () => {
    expect(directoryKeys.address("Alice@Example.com").pk).toBe("ADDR#alice@example.com");
  });

  it("builds member keys with a user GSI", () => {
    expect(directoryKeys.member("m1", "Alice@Example.com")).toEqual({
      pk: "MBX#m1",
      sk: "MEMBER#alice@example.com",
      gsi1pk: "USER#alice@example.com",
      gsi1sk: "MBX#m1",
    });
  });

  it("shards search tokens by their first two characters", () => {
    expect(mailKeys.searchToken("m1", "invoice", "U1")).toEqual({
      pk: "MBX#m1#S#in",
      sk: "invoice#U1",
    });
    expect(searchShard("m1", "inv")).toBe("MBX#m1#S#in");
  });

  it("hashes Message-ID headers", () => {
    const { sk } = mailKeys.messageIdMap("m1", " <abc@example.com> ");
    expect(sk).toMatch(/^MID#[0-9a-f]{40}$/);
    expect(mailKeys.messageIdMap("m1", "<abc@example.com>").sk).toBe(sk);
  });
});
