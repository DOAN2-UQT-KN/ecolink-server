export const NOTIFICATION_PREFERENCE_KEYS = [
  "campaignNew",
  "campaignNearbyVerify",
  "campaignDone",
  "campaignCompletionRejected",
  "volunteerRequest",
  "reportStatus",
] as const;

export type NotificationPreferenceKey =
  (typeof NOTIFICATION_PREFERENCE_KEYS)[number];

export type NotificationPreferences = Record<
  NotificationPreferenceKey,
  boolean
>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  campaignNew: true,
  campaignNearbyVerify: true,
  campaignDone: true,
  campaignCompletionRejected: true,
  volunteerRequest: true,
  reportStatus: true,
};

/** Kinds that bypass user opt-out (e.g. admin workflow). */
const ADMIN_ONLY_NOTIFICATION_KINDS = new Set([
  "CAMPAIGN_COMPLETION_PENDING_ADMIN",
  "ORGANIZATION_CONTACT_VERIFY",
  "ORGANIZATION_APPROVED",
  "ORGANIZATION_REJECTED",
  "ORG_APPLICATION_OTP",
  "ORG_APPLICATION_RECEIVED",
  "ORG_APPLICATION_NEEDS_INFO",
  "ORG_APPLICATION_REJECTED",
  "ORG_ACCOUNT_ACTIVATION",
  "REPORT_APPROVED",
  "REPORT_REJECTED",
  "RESET_PASSWORD",
  "GENERIC",
]);

export function notificationKindToPreferenceKey(
  kind: string,
): NotificationPreferenceKey | null {
  if (ADMIN_ONLY_NOTIFICATION_KINDS.has(kind)) {
    return null;
  }
  switch (kind) {
    case "CAMPAIGN_CREATED":
      return "campaignNew";
    case "CAMPAIGN_VERIFY_INVITE":
    case "CAMPAIGN_COMPLETION_VERIFY_INVITE":
      return "campaignNearbyVerify";
    case "CAMPAIGN_DONE":
      return "campaignDone";
    case "CAMPAIGN_COMPLETION_APPROVED_BY_ADMIN":
      return "campaignDone";
    case "CAMPAIGN_COMPLETION_REJECTED_BY_ADMIN":
      return "campaignCompletionRejected";
    case "VOLUNTEER_REQUEST":
    case "VOLUNTEER_APPROVED":
    case "VOLUNTEER_REJECTED":
      return "volunteerRequest";
    case "REPORT_STATUS":
    case "REPORT_READY":
      return "reportStatus";
    case "CAMPAIGN_SUBMISSION_PENDING_REVIEW":
    case "CAMPAIGN_SUBMISSION_APPROVED":
    case "TASK_ASSIGNED":
      return "campaignNew";
    default:
      return null;
  }
}

export function mergeNotificationPreferences(
  stored: unknown,
): NotificationPreferences {
  const base = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  if (stored == null || typeof stored !== "object" || Array.isArray(stored)) {
    return base;
  }
  for (const key of NOTIFICATION_PREFERENCE_KEYS) {
    const v = (stored as Record<string, unknown>)[key];
    if (typeof v === "boolean") {
      base[key] = v;
    }
  }
  return base;
}

export function isNotificationEnabledForUser(
  prefs: NotificationPreferences,
  kind: string,
): boolean {
  const key = notificationKindToPreferenceKey(kind);
  if (key == null) {
    return true;
  }
  return prefs[key] !== false;
}
