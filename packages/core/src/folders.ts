// System folders. No imports, so browser code can use this module.
export const SYSTEM_FOLDERS = ["inbox", "sent", "junk", "trash", "archive"] as const;
export type SystemFolder = (typeof SYSTEM_FOLDERS)[number];

export function isSystemFolder(value: unknown): value is SystemFolder {
  return typeof value === "string" && (SYSTEM_FOLDERS as readonly string[]).includes(value);
}
