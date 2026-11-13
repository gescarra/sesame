import { describe, expect, it } from "vitest";
import { parseBasic, usernameMatches } from "./auth.ts";
import { parseRequest, RequestError } from "./request.ts";

const noHeaders = () => undefined;

describe("parseRequest", () => {
  it("reads the plain query string and the protocol headers", () => {
    const headers: Record<string, string> = { "ms-asprotocolversion": "14.1", "x-ms-policykey": "42" };
    const req = parseRequest(
      "?Cmd=SmartReply&User=alice&DeviceId=ABC123&DeviceType=iPhone&ItemId=inbox%3A01X&SaveInSent=T",
      (name) => headers[name],
    );
    expect(req).toEqual({
      cmd: "SmartReply",
      user: "alice",
      deviceId: "ABC123",
      deviceType: "iPhone",
      protocolVersion: "14.1",
      policyKey: "42",
      params: { ItemId: "inbox:01X", SaveInSent: "T" },
    });
  });

  it("reads the base64 form", () => {
    const buf = Buffer.concat([
      Buffer.from([141, 9, 0x09, 0x04]), // 14.1, FolderSync, locale 0x0409
      Buffer.from([4, 0xde, 0xad, 0xbe, 0xef]), // DeviceId
      Buffer.from([4, 0xd2, 0x04, 0x00, 0x00]), // PolicyKey 1234
      Buffer.from([6]),
      Buffer.from("iPhone"),
      Buffer.from([8, 5]),
      Buffer.from("alice"), // User
      Buffer.from([7, 1, 0x01]), // Options: SaveInSent
    ]);
    expect(parseRequest(buf.toString("base64"), noHeaders)).toEqual({
      cmd: "FolderSync",
      user: "alice",
      deviceId: "DEADBEEF",
      deviceType: "iPhone",
      protocolVersion: "14.1",
      policyKey: "1234",
      params: { SaveInSent: "T" },
    });
  });

  it("rejects requests without a usable command or device", () => {
    expect(() => parseRequest("DeviceId=A&DeviceType=iPhone", noHeaders)).toThrow(RequestError);
    expect(() => parseRequest("Cmd=Sync&DeviceType=iPhone", noHeaders)).toThrow(/DeviceId/);
    expect(() => parseRequest("Cmd=Sync&DeviceId=A/B&DeviceType=iPhone", noHeaders)).toThrow(/DeviceId/);
    expect(() => parseRequest("Cmd=Sync&DeviceId=AB", noHeaders)).toThrow(/DeviceType/);
    expect(() => parseRequest(Buffer.from([141, 99]).toString("base64"), noHeaders)).toThrow(/command/);
  });
});

describe("Basic credentials", () => {
  it("splits at the first colon, so passwords may contain colons", () => {
    const header = `Basic ${Buffer.from("alice@example.com:a:b").toString("base64")}`;
    expect(parseBasic(header)).toEqual({ username: "alice@example.com", password: "a:b" });
    expect(parseBasic("Bearer xyz")).toBeUndefined();
    expect(parseBasic(undefined)).toBeUndefined();
  });

  it("matches the owner by email, DOMAIN\\user or local part only", () => {
    expect(usernameMatches(" Alice@Example.COM ", "alice@example.com")).toBe(true);
    expect(usernameMatches("CORP\\alice", "alice@example.com")).toBe(true);
    expect(usernameMatches("alice", "alice@example.com")).toBe(true);
    expect(usernameMatches("alice@example.org", "alice@example.com")).toBe(false);
    expect(usernameMatches("al", "alice@example.com")).toBe(false);
    expect(usernameMatches("", "alice@example.com")).toBe(false);
  });
});
