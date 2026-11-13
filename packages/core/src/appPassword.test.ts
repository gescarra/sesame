import { describe, expect, it } from "vitest";
import {
  APP_PASSWORD_LENGTH,
  formatAppPassword,
  hashAppPassword,
  isWellFormedAppPassword,
  newAppPassword,
  normalizeAppPassword,
} from "./appPassword.ts";
import { directoryKeys } from "./keys.ts";

describe("app passwords", () => {
  it("are 24 symbols of Crockford base32 and differ every time", () => {
    const a = newAppPassword();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{24}$/);
    expect(a).toHaveLength(APP_PASSWORD_LENGTH);
    expect(newAppPassword()).not.toBe(a);
  });

  it("show in groups of four and read back however they're typed", () => {
    const p = "ABCD0123EFGH4567JKMN89PQ";
    expect(formatAppPassword(p)).toBe("ABCD-0123-EFGH-4567-JKMN-89PQ");
    expect(normalizeAppPassword("abcd-0123 efgh-4567\tjkmn 89pq")).toBe(p);
    // O, I and L aren't in the alphabet; they read as the digits they look like.
    expect(normalizeAppPassword("ABCD-O123-EFGH-4567-JKMN-89PQ".replace("1", "l"))).toBe(p);
    expect(isWellFormedAppPassword(p)).toBe(true);
    expect(isWellFormedAppPassword("ABCD")).toBe(false);
    expect(isWellFormedAppPassword("ABCD0123EFGH4567JKMN89PU")).toBe(false);
  });

  it("are stored by hash, listed under the user", () => {
    const hash = hashAppPassword("ABCD0123EFGH4567JKMN89PQ");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(directoryKeys.appPassword(hash, "Alice@Example.com", "pw1")).toEqual({
      pk: `APPPW#${hash}`,
      sk: "META",
      gsi1pk: "USER#alice@example.com",
      gsi1sk: "APPPW#pw1",
    });
  });
});
