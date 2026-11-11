import { describe, expect, it } from "vitest";
import { child, childText, decode, el, encode, WbxmlError } from "./codec.ts";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");

// FolderSync with SyncKey 0, as in the [MS-ASCMD] examples: header, SWITCH_PAGE 7,
// FolderSync (0x16|0x40), SyncKey (0x12|0x40), STR_I "0", END, END.
const FOLDER_SYNC_0 = hex("03 01 6a 00  00 07  56  52 03 30 00 01  01");

describe("WBXML codec", () => {
  it("decodes a FolderSync request", () => {
    expect(decode(FOLDER_SYNC_0)).toEqual({
      tag: "FolderHierarchy:FolderSync",
      children: [{ tag: "FolderHierarchy:SyncKey", text: "0" }],
    });
  });

  it("encodes byte for byte what it decodes", () => {
    const doc = el("FolderHierarchy:FolderSync", [el("FolderHierarchy:SyncKey", "0")]);
    expect(encode(doc)).toEqual(FOLDER_SYNC_0);
  });

  it("switches code pages in both directions", () => {
    const doc = el("Provision:Provision", [
      el("Settings:DeviceInformation", [el("Settings:Set", [el("Settings:Model", "iPhone")])]),
      el("Provision:Policies", [
        el("Provision:Policy", [el("Provision:PolicyType", "MS-EAS-Provisioning-WBXML")]),
      ]),
    ]);
    const bytes = encode(doc);
    // Page 14 is the default after the root's switch; Settings (18) is switched in and out again.
    expect(bytes.subarray(0, 7)).toEqual(hex("03 01 6a 00 00 0e 45"));
    expect(bytes.includes(hex("00 12 56"))).toBe(true);
    expect(bytes.includes(hex("00 0e 46"))).toBe(true);
    expect(decode(bytes)).toEqual(doc);
  });

  it("round-trips opaque data with a multi-byte length", () => {
    const mime = Buffer.alloc(200, 0x41);
    const doc = el("ComposeMail:SendMail", [el("ComposeMail:ClientId", "abc"), el("ComposeMail:Mime", mime)]);
    const bytes = encode(doc);
    expect(bytes.includes(hex("c3 81 48"))).toBe(true); // OPAQUE, length 200
    expect(childText(decode(bytes), "ComposeMail:ClientId")).toBe("abc");
    expect(child(decode(bytes), "ComposeMail:Mime")?.opaque).toEqual(mime);
  });

  it("keeps UTF-8 text", () => {
    const doc = el("Settings:Settings", [el("Settings:UserDisplayName", "Zoë Ångström 📬")]);
    expect(decode(encode(doc))).toEqual(doc);
  });

  it("writes empty elements without content", () => {
    const bytes = encode(el("Settings:Settings", [el("Settings:UserInformation", [el("Settings:Get")])]));
    expect(bytes).toEqual(hex("03 01 6a 00 00 12 45 5d 07 01 01"));
    expect(decode(bytes)).toEqual({
      tag: "Settings:Settings",
      children: [{ tag: "Settings:UserInformation", children: [{ tag: "Settings:Get" }] }],
    });
  });

  it("names tokens it has no table entry for instead of failing", () => {
    // Page 1 (Contacts) isn't in the tables: tag 0x05 with no content.
    const doc = decode(hex("03 01 6a 00 00 07 56 00 01 05 01"));
    expect(doc.children?.[0]?.tag).toBe("Page1:0x05");
  });

  it("reads strings from the string table and entities", () => {
    // String table "ab\0"; SyncKey holds STR_T 0, then ENTITY U+00E9.
    const doc = decode(hex("03 01 6a 03 61 62 00  00 07 56 52 83 00 02 81 69 01 01"));
    expect(childText(doc, "FolderHierarchy:SyncKey")).toBe("abé");
  });

  it("rejects attributes and truncated input", () => {
    expect(() => decode(hex("03 01 6a 00 00 07 d6"))).toThrow(WbxmlError);
    expect(() => decode(hex("03 01 6a 00 00 07 56 52 03 30"))).toThrow(WbxmlError);
    expect(() => decode(hex("03 01 6a 00 00 07 56 52"))).toThrow(WbxmlError);
  });

  it("refuses to encode an unknown tag", () => {
    expect(() => encode(el("Ping:Nope"))).toThrow(/no WBXML token/);
  });
});
