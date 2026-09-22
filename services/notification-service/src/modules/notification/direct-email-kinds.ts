import { NotificationKind } from "@prisma/client";

/**
 * Kinds that may be addressed with `payload.toEmail` instead of a `userId`.
 *
 * Every other kind must resolve its recipient through identity-service, so a caller cannot
 * use this service to mail arbitrary addresses. These are the exceptions because the
 * recipient genuinely has no account yet: an organization's contact mailbox, the four steps
 * of the application pipeline (OTP, acknowledgement, request for more information, and
 * rejection), and the activation mail that creates the ORG account.
 */
export const KINDS_ALLOWING_DIRECT_TO_EMAIL: ReadonlySet<NotificationKind> =
  new Set<NotificationKind>([
    NotificationKind.ORGANIZATION_CONTACT_VERIFY,
    NotificationKind.ORG_APPLICATION_OTP,
    NotificationKind.ORG_APPLICATION_RECEIVED,
    NotificationKind.ORG_APPLICATION_NEEDS_INFO,
    NotificationKind.ORG_APPLICATION_REJECTED,
    NotificationKind.ORG_ACCOUNT_ACTIVATION,
  ]);

export function allowsDirectToEmail(kind: NotificationKind): boolean {
  return KINDS_ALLOWING_DIRECT_TO_EMAIL.has(kind);
}
