import { NotificationKind } from "@prisma/client";

/**
 * Kinds that may be addressed with `payload.toEmail` instead of a `userId`.
 *
 * Every other kind must resolve its recipient through identity-service, so a caller cannot
 * use this service to mail arbitrary addresses. These are the exceptions because the
 * recipient may genuinely have no account yet: an organization's contact mailbox, the steps
 * of the application pipeline (OTP, acknowledgement, request for more information,
 * rejection), the owner-confirmation mails (request, declined, expired, withdrawn notice,
 * "you were added"), and the activation mail for an owner's newly created account.
 */
export const KINDS_ALLOWING_DIRECT_TO_EMAIL: ReadonlySet<NotificationKind> =
  new Set<NotificationKind>([
    NotificationKind.ORGANIZATION_CONTACT_VERIFY,
    NotificationKind.ORG_APPLICATION_OTP,
    NotificationKind.ORG_APPLICATION_RECEIVED,
    NotificationKind.ORG_APPLICATION_NEEDS_INFO,
    NotificationKind.ORG_APPLICATION_REJECTED,
    NotificationKind.ORG_APPLICATION_DRAFT_STARTED,
    NotificationKind.ORG_APPLICATION_DRAFT_UPDATED,
    NotificationKind.ORG_INVITATION,
    NotificationKind.ACCOUNT_ACTIVATION,
    NotificationKind.ORG_OWNER_CONFIRMATION_REQUEST,
    NotificationKind.ORG_OWNER_DECLINED,
    NotificationKind.ORG_OWNER_CONFIRMATION_EXPIRED,
    NotificationKind.ORG_APPLICATION_WITHDRAWN_NOTICE,
    NotificationKind.ORG_OWNER_ATTACHED,
  ]);

export function allowsDirectToEmail(kind: NotificationKind): boolean {
  return KINDS_ALLOWING_DIRECT_TO_EMAIL.has(kind);
}
