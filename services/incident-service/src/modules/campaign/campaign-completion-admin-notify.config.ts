/**
 * Comma-separated user UUIDs (identity) that receive in-app notifications when a
 * manager submits a campaign for final admin completion approval.
 */
export function getCampaignCompletionAdminNotifyUserIds(): string[] {
  const raw = process.env.CAMPAIGN_COMPLETION_ADMIN_NOTIFY_USER_IDS?.trim();
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
