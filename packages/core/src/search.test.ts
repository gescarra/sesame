import { describe, expect, it } from "vitest";
import {
  addressTokens,
  buildIndex,
  fold,
  htmlToSearchText,
  MAX_TOKENS,
  parseQuery,
  words,
} from "./search.ts";

describe("tokenizing", () => {
  it("folds case and accents and drops stopwords and short tokens", () => {
    expect(fold("Résumé ÅNGSTRÖM")).toBe("resume angstrom");
    expect(words("The Q3 résumé is attached, a b x2")).toEqual(["q3", "resume", "attached", "x2"]);
  });

  it("makes addresses findable whole and in parts", () => {
    expect(addressTokens("Bob.Smith@Mail.Example.org")).toEqual([
      "bob.smith@mail.example.org",
      "bob.smith",
      "mail.example.org",
      "mail",
      "example",
      "org",
      "bob",
      "smith",
    ]);
  });

  it("strips HTML for indexing", () => {
    expect(
      htmlToSearchText("<style>p{}</style><p>Fish &amp; chips&nbsp;&#8364;5</p>").replace(/\s+/g, " ").trim(),
    ).toBe("Fish & chips €5");
  });
});

describe("buildIndex", () => {
  it("records which fields each token came from", () => {
    const index = buildIndex({
      subject: "Quarterly report",
      from: { name: "Bob Smith", address: "bob@example.org" },
      to: [{ address: "alice@example.com" }],
      cc: [],
      attachmentNames: ["report-final.pdf"],
      bodyText: "Here is the report for Bob.",
    });
    expect([...(index.get("report") ?? [])]).toEqual(["s", "a", "b"]);
    expect([...(index.get("bob") ?? [])]).toEqual(["f", "b"]);
    expect([...(index.get("alice@example.com") ?? [])]).toEqual(["t"]);
    expect(index.has("the")).toBe(false);
  });

  it("caps the token count, keeping header tokens over body tokens", () => {
    const body = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
    const index = buildIndex({
      subject: "Important subject",
      to: [],
      cc: [],
      attachmentNames: [],
      bodyText: body,
    });
    expect(index.size).toBe(MAX_TOKENS);
    expect(index.has("important")).toBe(true);
    expect(index.has("word499")).toBe(false);
  });
});

describe("parseQuery", () => {
  it("parses words and operators", () => {
    expect(parseQuery('report from:bob subject:"Q3 plans" has:attachment is:unread in:junk')).toEqual({
      terms: [
        { prefix: "report" },
        { prefix: "bob", field: "f" },
        { prefix: "q3", field: "s" },
        { prefix: "plans", field: "s" },
      ],
      hasAttachment: true,
      unread: true,
      flagged: false,
      folder: "junk",
    });
  });

  it("matches whole addresses and understands in:anywhere", () => {
    expect(parseQuery("to:Alice@Example.com in:anywhere")).toMatchObject({
      terms: [{ prefix: "alice@example.com", field: "t" }],
      folder: "anywhere",
    });
    expect(parseQuery("bob@example.org").terms).toEqual([{ prefix: "bob@example.org" }]);
  });

  it("treats unknown operators as words and ignores stopwords", () => {
    expect(parseQuery("the http://x.test").terms).toEqual([{ prefix: "http" }, { prefix: "test" }]);
    expect(parseQuery("is:flagged").flagged).toBe(true);
  });
});
