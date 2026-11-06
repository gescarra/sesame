// Mailbox storage quotas. No imports, so the SPA can use them too.

/**
 * A mailbox takes new mail while it's under quota, so the message that fills it may overshoot.
 * DynamoDB conditions can't add, so "used < quota" is the check delivery can make atomically.
 */
export function isMailboxFull(m: { usedBytes?: number; quotaBytes?: number }): boolean {
  return m.quotaBytes !== undefined && (m.usedBytes ?? 0) >= m.quotaBytes;
}

/** Condition on the mailbox item that admits one more message. */
export const UNDER_QUOTA_CONDITION =
  "(attribute_not_exists(quotaBytes) OR attribute_not_exists(usedBytes) OR usedBytes < quotaBytes)";
