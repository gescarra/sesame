// Autodiscover ([MS-ASCMD] Autodiscover, mobilesync schema): tells a phone where the ActiveSync
// endpoint is from just an email address, so the user doesn't type a server name.
// The answer is the same for everyone: this endpoint's own URL. It reads nothing and needs no
// sign-in, so it can't be used to learn which addresses exist.
const RESPONSE_SCHEMA = "http://schemas.microsoft.com/exchange/autodiscover/mobilesync/responseschema/2006";

export const AUTODISCOVER_PATH = "/autodiscover/autodiscover.xml";
/** Requests are a few hundred bytes; anything much larger isn't one. */
export const MAX_AUTODISCOVER_BYTES = 16 * 1024;

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The address in the request, if it looks like one. Only echoed back, never looked up. */
export function requestedAddress(body: string): string | undefined {
  const match = body.match(/<(?:\w+:)?EMailAddress>\s*([^<\s]{3,320})\s*<\/(?:\w+:)?EMailAddress>/i);
  const address = match?.[1];
  return address && /^[^@\s]+@[^@\s]+$/.test(address) ? address : undefined;
}

export function autodiscoverResponse(host: string, address: string | undefined): string {
  const url = `https://${host}/Microsoft-Server-ActiveSync`;
  const user = address ? `<User><EMailAddress>${escapeXml(address)}</EMailAddress></User>` : "";
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">',
    `<Response xmlns="${RESPONSE_SCHEMA}">`,
    "<Culture>en:us</Culture>",
    user,
    "<Action><Settings><Server>",
    "<Type>MobileSync</Type>",
    `<Url>${escapeXml(url)}</Url>`,
    `<Name>${escapeXml(url)}</Name>`,
    "</Server></Settings></Action>",
    "</Response>",
    "</Autodiscover>",
  ].join("");
}
