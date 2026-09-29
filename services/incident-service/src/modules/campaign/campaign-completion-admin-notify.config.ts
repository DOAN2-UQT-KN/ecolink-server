/**
 * Comma-separated user UUIDs (identity) of the platform admins who receive campaign workflow
 * notifications: campaigns waiting for review and completions waiting for approval.
 * `CAMPAIGN_ADMIN_NOTIFY_USER_IDS`; the older `CAMPAIGN_COMPLETION_ADMIN_NOTIFY_USER_IDS` is
 * still read when the new one is not set.
 */
export function getCampaignAdminNotifyUserIds(): string[] {
  const raw = (
    process.env.CAMPAIGN_ADMIN_NOTIFY_USER_IDS ??
    process.env.CAMPAIGN_COMPLETION_ADMIN_NOTIFY_USER_IDS
  )?.trim();
  if (!raw) {
    return [];
  }
  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((id) => id.length > 0),
    ),
  ];
}

/** @deprecated use getCampaignAdminNotifyUserIds */
export const getCampaignCompletionAdminNotifyUserIds = getCampaignAdminNotifyUserIds;
