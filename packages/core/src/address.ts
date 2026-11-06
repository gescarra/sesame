// Email address handling. Addresses are stored and compared in normalized form.

const ADDRESS_RE = /^[^\s@<>()",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Lowercases, trims and strips angle brackets. Throws on anything that isn't a bare address. */
export function normalizeAddress(input: string): string {
  const addr = input
    .trim()
    .replace(/^<(.*)>$/, "$1")
    .trim()
    .toLowerCase();
  if (!ADDRESS_RE.test(addr)) {
    throw new Error(`invalid email address: ${JSON.stringify(input)}`);
  }
  return addr;
}

export function isValidAddress(input: string): boolean {
  try {
    normalizeAddress(input);
    return true;
  } catch {
    return false;
  }
}

/** Domain part of an address, normalized. */
export function domainOf(address: string): string {
  const addr = normalizeAddress(address);
  return addr.slice(addr.lastIndexOf("@") + 1);
}

export function normalizeDomain(input: string): string {
  const domain = input.trim().replace(/\.$/, "").toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
    throw new Error(`invalid domain: ${JSON.stringify(input)}`);
  }
  return domain;
}
