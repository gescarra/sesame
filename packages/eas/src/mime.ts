// Header-level edits to a MIME message a phone sent. The body is kept byte for byte, so HTML,
// inline images and attachments arrive exactly as the phone built them. Headers are handled as
// latin1 text, which maps every byte to one character and back, so 8-bit bytes survive too.
import { addressParser } from "postal-mime";

interface Header {
  /** Lower-cased field name. */
  name: string;
  /** The whole field as received, folded lines and all, without the final line break. */
  raw: string;
}

export class MimeMessage {
  private constructor(
    private headers: Header[],
    private readonly body: Buffer,
    /** "\r\n" or, from a sloppy client, "\n"; edits use the same. */
    private readonly eol: string,
  ) {}

  /** Splits at the first empty line. A message without one is all headers. */
  static parse(raw: Buffer): MimeMessage {
    const text = raw.toString("latin1");
    const crlf = text.indexOf("\r\n\r\n");
    const lf = text.indexOf("\n\n");
    let headerEnd: number;
    let bodyStart: number;
    if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
      headerEnd = crlf;
      bodyStart = crlf + 4;
    } else if (lf >= 0) {
      headerEnd = lf;
      bodyStart = lf + 2;
    } else {
      headerEnd = text.length;
      bodyStart = text.length;
    }
    const eol = crlf >= 0 && (lf < 0 || crlf <= lf) ? "\r\n" : "\n";
    const headers: Header[] = [];
    for (const line of text.slice(0, headerEnd).split(/\r?\n/)) {
      const last = headers[headers.length - 1];
      if (/^[ \t]/.test(line) && last) {
        last.raw += eol + line;
      } else if (line.includes(":")) {
        headers.push({ name: line.slice(0, line.indexOf(":")).trim().toLowerCase(), raw: line });
      }
    }
    return new MimeMessage(headers, raw.subarray(bodyStart), eol);
  }

  /** The first field's value, unfolded and trimmed. */
  get(name: string): string | undefined {
    const h = this.headers.find((x) => x.name === name.toLowerCase());
    return h === undefined ? undefined : unfold(h);
  }

  getAll(name: string): string[] {
    return this.headers.filter((x) => x.name === name.toLowerCase()).map(unfold);
  }

  remove(name: string) {
    this.headers = this.headers.filter((x) => x.name !== name.toLowerCase());
  }

  /** Replaces the first field of that name in place, dropping any others, or adds one at the end. */
  set(name: string, value: string) {
    const lower = name.toLowerCase();
    const i = this.headers.findIndex((x) => x.name === lower);
    const field = { name: lower, raw: `${name}: ${value}` };
    this.headers = this.headers.filter((x, j) => x.name !== lower || j === i);
    if (i >= 0) this.headers[i] = field;
    else this.headers.push(field);
  }

  toBuffer(): Buffer {
    const head = this.headers.map((h) => h.raw + this.eol).join("");
    return Buffer.concat([Buffer.from(head + this.eol, "latin1"), this.body]);
  }
}

function unfold(h: Header): string {
  return h.raw
    .slice(h.raw.indexOf(":") + 1)
    .replace(/\r?\n(?=[ \t])/g, "")
    .trim();
}

/** An address for a header: a quoted ASCII name, or an RFC 2047 encoded one. */
export function headerAddress(name: string | undefined, address: string): string {
  if (!name) return address;
  if (/^[\x20-\x7e]*$/.test(name)) return `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
  return `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?= <${address}>`;
}

export interface ParsedAddress {
  name: string;
  address: string;
}

/** Every mailbox in address fields such as To and Cc, groups flattened. */
export function parseAddresses(values: string[]): ParsedAddress[] {
  return values.flatMap((value) =>
    addressParser(value, { flatten: true }).flatMap((a) =>
      a.address ? [{ name: a.name, address: a.address }] : [],
    ),
  );
}
