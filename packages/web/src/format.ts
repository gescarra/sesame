// Display formatting. Pure functions, so they're unit tested without a DOM.
import type { DeliveryStatus, EmailAddress } from "@sesame/core/dto";

export function displayName(a: EmailAddress | undefined): string {
  if (!a) return "(unknown sender)";
  return a.name?.trim() || a.address;
}

export function formatAddress(a: EmailAddress): string {
  return a.name?.trim() ? `${a.name.trim()} <${a.address}>` : a.address;
}

export function formatAddresses(list: EmailAddress[]): string {
  return list.map(formatAddress).join(", ");
}

/** Time for today, "Mon 3" style within the year, full date otherwise. */
export function formatListDate(iso: string, now = new Date(), locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

export function formatFullDate(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const FOLDER_LABELS: Record<string, string> = {
  inbox: "Inbox",
  sent: "Sent",
  junk: "Junk",
  trash: "Trash",
  archive: "Archive",
  flagged: "Flagged",
  search: "Search results",
};

export function folderLabel(name: string): string {
  return FOLDER_LABELS[name] ?? name;
}

const STATUS_LABELS: Record<DeliveryStatus, string> = {
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  delayed: "Delayed",
  bounced: "Bounced",
  complained: "Marked as spam",
  rejected: "Rejected",
  failed: "Failed",
};

export function statusLabel(status: DeliveryStatus): string {
  return STATUS_LABELS[status] ?? status;
}
