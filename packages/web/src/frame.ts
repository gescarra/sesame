// Builds the document for the sandboxed iframe that shows an HTML message body.
//
// The HTML was sanitized at ingest; this is the isolation layer on top. The frame runs with
// `sandbox` minus allow-scripts and allow-same-origin, so it has an opaque origin and no
// script. Its CSP blocks every load except data: URIs, the presigned URLs of the message's own
// inline images and, only when the user asks, remote images. That keeps tracking pixels quiet.

export interface FrameOptions {
  /** Content-ID (without <>) to a presigned URL for that inline part. */
  inlineImages: Map<string, string>;
  allowRemoteImages: boolean;
}

function decodeCid(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/** Content-IDs referenced as cid: URLs in the body. */
export function referencedContentIds(html: string): string[] {
  const ids = new Set<string>();
  for (const m of html.matchAll(/cid:([^"'\s)>]+)/gi)) {
    if (m[1]) ids.add(decodeCid(m[1]));
  }
  return [...ids];
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Rewrites cid: references to the URLs in `images`; unknown ones are left to fail closed. */
export function rewriteCids(html: string, images: Map<string, string>): string {
  return html.replace(/cid:([^"'\s)>]+)/gi, (match, id: string) => {
    const url = images.get(decodeCid(id));
    return url ? escapeAttr(url) : match;
  });
}

/** Origins (scheme://host) of the given URLs, for the frame's img-src. */
export function originsOf(urls: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    try {
      out.add(new URL(u).origin);
    } catch {
      // Not a URL; it simply won't be allowed.
    }
  }
  return [...out];
}

export function frameCsp(opts: FrameOptions): string {
  const img = opts.allowRemoteImages
    ? ["data:", "https:"]
    : ["data:", ...originsOf(opts.inlineImages.values())];
  return [
    "default-src 'none'",
    `img-src ${img.join(" ")}`,
    "style-src 'unsafe-inline'",
    `font-src data:${opts.allowRemoteImages ? " https:" : ""}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export function buildFrameDocument(html: string, opts: FrameOptions): string {
  const body = rewriteCids(html, opts.inlineImages);
  // Most HTML mail assumes a white page; give it one, inset from the frame edge.
  const base = `html{color-scheme:light}body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;color:#1f2328;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}pre{white-space:pre-wrap}`;
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(frameCsp(opts))}">`,
    '<meta name="referrer" content="no-referrer">',
    '<base target="_blank">',
    `<style>${base}</style>`,
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}

/** Whether the body references remote images that the CSP will block. */
export function hasRemoteImages(html: string): boolean {
  return /<img\b[^>]*\bsrc\s*=\s*["']?https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html);
}
