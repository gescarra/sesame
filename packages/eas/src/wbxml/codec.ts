// WBXML 1.3 as Exchange ActiveSync uses it ([MS-ASWBXML]): tags only, no attributes, inline
// strings and opaque data. Documents decode to a small element tree and encode back from one.
import { tagFor, tokenFor } from "./codepages.ts";

/**
 * One element. `tag` is qualified with its code page, e.g. "FolderHierarchy:SyncKey".
 * An element holds child elements, or text, or opaque bytes (MIME bodies), or nothing.
 */
export interface Element {
  tag: string;
  children?: Element[];
  text?: string;
  opaque?: Buffer;
}

const SWITCH_PAGE = 0x00;
const END = 0x01;
const ENTITY = 0x02;
const STR_I = 0x03;
const STR_T = 0x83;
const OPAQUE = 0xc3;
const HAS_ATTRIBUTES = 0x80;
const HAS_CONTENT = 0x40;

// Header: WBXML 1.3, unknown public identifier, UTF-8, no string table.
const HEADER = [0x03, 0x01, 0x6a, 0x00];

// --- Building ---------------------------------------------------------------

/** Builds an element: `el("Ping:Status", "1")`, `el("Ping:Ping", [child, …])`. */
export function el(
  tag: string,
  content?: string | number | Buffer | (Element | false | undefined)[],
): Element {
  if (content === undefined) return { tag };
  if (Buffer.isBuffer(content)) return { tag, opaque: content };
  if (Array.isArray(content)) return { tag, children: content.filter((c): c is Element => Boolean(c)) };
  return { tag, text: String(content) };
}

// --- Reading ----------------------------------------------------------------

export function child(parent: Element | undefined, tag: string): Element | undefined {
  return parent?.children?.find((c) => c.tag === tag);
}

export function children(parent: Element | undefined, tag: string): Element[] {
  return parent?.children?.filter((c) => c.tag === tag) ?? [];
}

/** Text of a child element; opaque content is read as UTF-8. */
export function childText(parent: Element | undefined, tag: string): string | undefined {
  const c = child(parent, tag);
  if (!c) return undefined;
  return c.text ?? c.opaque?.toString("utf8") ?? "";
}

// --- Encoding ---------------------------------------------------------------

export function encode(root: Element): Buffer {
  const out: number[] = [...HEADER];
  const chunks: Buffer[] = [];
  let page = 0;

  const flush = () => {
    if (out.length) chunks.push(Buffer.from(out.splice(0)));
  };

  const write = (e: Element) => {
    const [tagPage, token] = tokenFor(e.tag);
    if (tagPage !== page) {
      out.push(SWITCH_PAGE, tagPage);
      page = tagPage;
    }
    const hasContent = Boolean(e.children?.length || e.text || e.opaque);
    out.push(hasContent ? token | HAS_CONTENT : token);
    if (!hasContent) return;
    if (e.children?.length) {
      for (const c of e.children) write(c);
    } else if (e.opaque) {
      out.push(OPAQUE, ...multiByte(e.opaque.length));
      flush();
      chunks.push(e.opaque);
    } else if (e.text) {
      out.push(STR_I);
      flush();
      chunks.push(Buffer.from(e.text, "utf8"), Buffer.from([0]));
    }
    out.push(END);
  };

  write(root);
  flush();
  return Buffer.concat(chunks);
}

/** mb_u_int32: seven bits a byte, most significant first, high bit set on all but the last. */
function multiByte(n: number): number[] {
  const bytes = [n & 0x7f];
  for (let v = n >>> 7; v > 0; v >>>= 7) bytes.unshift((v & 0x7f) | 0x80);
  return bytes;
}

// --- Decoding ---------------------------------------------------------------

export class WbxmlError extends Error {}

export function decode(input: Uint8Array): Element {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let pos = 0;
  let page = 0;

  const byte = () => {
    if (pos >= buf.length) throw new WbxmlError("unexpected end of WBXML");
    return buf[pos++] as number;
  };
  const mbInt = () => {
    let n = 0;
    for (let i = 0; i < 5; i++) {
      const b = byte();
      n = n * 128 + (b & 0x7f);
      if (!(b & 0x80)) return n;
    }
    throw new WbxmlError("mb_u_int32 is too long");
  };
  const take = (n: number) => {
    if (pos + n > buf.length) throw new WbxmlError("unexpected end of WBXML");
    const slice = buf.subarray(pos, pos + n);
    pos += n;
    return slice;
  };
  const cString = (from: number) => {
    const end = buf.indexOf(0, from);
    if (end < 0) throw new WbxmlError("unterminated string");
    return { text: buf.toString("utf8", from, end), next: end + 1 };
  };

  // Header
  const version = byte();
  if (version !== 0x01 && version !== 0x02 && version !== 0x03) {
    throw new WbxmlError(`unsupported WBXML version ${version}`);
  }
  if (mbInt() === 0) mbInt(); // public identifier given as a string-table index
  const charset = mbInt();
  if (charset !== 0x6a && charset !== 0) throw new WbxmlError(`unsupported charset ${charset}`);
  const stringTable = take(mbInt());

  const element = (): Element => {
    let token = byte();
    while (token === SWITCH_PAGE) {
      page = byte();
      token = byte();
    }
    if (token & HAS_ATTRIBUTES) throw new WbxmlError("WBXML attributes are not supported");
    const e: Element = { tag: tagFor(page, token & 0x3f) };
    if (!(token & HAS_CONTENT)) return e;

    let text = "";
    let hasText = false;
    for (;;) {
      const next = buf[pos];
      if (next === undefined) throw new WbxmlError("unexpected end of WBXML");
      if (next === END) {
        pos++;
        break;
      }
      if (next === SWITCH_PAGE) {
        pos++;
        page = byte();
      } else if (next === STR_I) {
        pos++;
        const s = cString(pos);
        text += s.text;
        hasText = true;
        pos = s.next;
      } else if (next === STR_T) {
        pos++;
        const offset = mbInt();
        const end = stringTable.indexOf(0, offset);
        if (offset >= stringTable.length || end < 0) throw new WbxmlError("bad string table reference");
        text += stringTable.toString("utf8", offset, end);
        hasText = true;
      } else if (next === ENTITY) {
        pos++;
        text += String.fromCodePoint(mbInt());
        hasText = true;
      } else if (next === OPAQUE) {
        pos++;
        e.opaque = Buffer.from(take(mbInt()));
      } else {
        e.children ??= [];
        e.children.push(element());
      }
    }
    if (hasText) e.text = text;
    return e;
  };

  return element();
}

/** An indented, XML-like rendering for logs and test failures. */
export function toXml(e: Element, indent = ""): string {
  if (e.children?.length) {
    return `${indent}<${e.tag}>\n${e.children.map((c) => toXml(c, `${indent}  `)).join("\n")}\n${indent}</${e.tag}>`;
  }
  if (e.opaque) return `${indent}<${e.tag}>[${e.opaque.length} bytes]</${e.tag}>`;
  if (e.text !== undefined) return `${indent}<${e.tag}>${e.text}</${e.tag}>`;
  return `${indent}<${e.tag}/>`;
}
