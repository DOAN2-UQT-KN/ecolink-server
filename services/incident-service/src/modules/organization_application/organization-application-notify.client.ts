import axios from "axios";
import {
  getHttpCircuit,
  HTTP_CIRCUIT_NOTIFICATION,
} from "../../resilience/http-circuit";

interface SuccessEnvelope<T> {
  success: boolean;
  data?: T;
}

function notificationCircuit() {
  return getHttpCircuit(HTTP_CIRCUIT_NOTIFICATION);
}

function appName(): string {
  return process.env.APP_NAME?.trim() || "DA2";
}

/**
 * Posts one notification job. Like the existing contact-email client, a missing
 * notification-service configuration degrades to a warning instead of failing the request
 * that triggered it — an application must not be lost because mail is down.
 */
async function enqueueJob(
  kind: string,
  payload: Record<string, string>,
  type: "email" | "website" = "email",
  userId?: string,
): Promise<void> {
  const baseURL = process.env.NOTIFICATION_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_NOTIFICATION_API_KEY?.trim();
  if (!baseURL || !key) {
    console.warn(
      `[incident-service] NOTIFICATION_SERVICE_URL or INTERNAL_NOTIFICATION_API_KEY not set; skipping ${kind} notification`,
    );
    return;
  }

  await notificationCircuit().run(async () => {
    const client = axios.create({
      baseURL: baseURL.replace(/\/$/, ""),
      timeout: 10_000,
      headers: { "x-internal-api-key": key },
    });

    const { data } = await client.post<SuccessEnvelope<{ jobId: string }>>(
      "/api/v1/notifications/jobs",
      { type, kind, userId, payload: { ...payload, appName: appName() } },
    );

    if (!data?.success) {
      throw new Error(`Notification service rejected the ${kind} job`);
    }
  });
}

/** The 6-digit code that gates the anonymous application form. */
export function enqueueApplicationOtpEmail(params: {
  toEmail: string;
  otp: string;
  expiresInMinutes: number;
  applyUrl: string;
  locale?: string;
}): Promise<void> {
  return enqueueJob("ORG_APPLICATION_OTP", {
    toEmail: params.toEmail,
    otp: params.otp,
    expiresInMinutes: String(params.expiresInMinutes),
    applyUrl: params.applyUrl,
    locale: params.locale ?? "vi",
  });
}

/**
 * Sent when the code opens a new draft: the link back to the editor, so the applicant can
 * close the tab and return once they have every owner's details.
 */
export function enqueueApplicationDraftStartedEmail(params: {
  toEmail: string;
  applicationCode: string;
  editUrl: string;
  expiresInDays: number;
  locale?: string;
}): Promise<void> {
  return enqueueJob("ORG_APPLICATION_DRAFT_STARTED", {
    toEmail: params.toEmail,
    applicationCode: params.applicationCode,
    editUrl: params.editUrl,
    expiresInDays: String(params.expiresInDays),
    locale: params.locale ?? "vi",
  });
}

/** The submitter pressed "Save draft"; at most once an hour per application. */
export function enqueueApplicationDraftUpdatedEmail(params: {
  toEmail: string;
  applicationCode: string;
  organizationName: string;
  savedAt: string;
  editUrl: string;
  locale?: string;
}): Promise<void> {
  return enqueueJob("ORG_APPLICATION_DRAFT_UPDATED", {
    toEmail: params.toEmail,
    applicationCode: params.applicationCode,
    organizationName: params.organizationName,
    savedAt: params.savedAt,
    editUrl: params.editUrl,
    locale: params.locale ?? "vi",
  });
}

/** Invitation to join an organization as a member, with the accept / decline link. */
export function enqueueOrgInvitationEmail(params: {
  toEmail: string;
  inviteeName: string;
  inviterName: string;
  organizationName: string;
  invitationUrl: string;
  expiresInDays: number;
  locale?: string;
}): Promise<void> {
  return enqueueJob("ORG_INVITATION", {
    toEmail: params.toEmail,
    inviteeName: params.inviteeName,
    inviterName: params.inviterName,
    organizationName: params.organizationName,
    invitationUrl: params.invitationUrl,
    expiresInDays: String(params.expiresInDays),
    locale: params.locale ?? "vi",
  });
}

/** Acknowledgement carrying the tracking code and link. */
export function enqueueApplicationReceivedEmail(params: {
  toEmail: string;
  organizationName: string;
  applicationCode: string;
  trackUrl: string;
  locale?: string;
}): Promise<void> {
  return enqueueJob("ORG_APPLICATION_RECEIVED", {
    toEmail: params.toEmail,
    organizationName: params.organizationName,
    applicationCode: params.applicationCode,
    trackUrl: params.trackUrl,
    locale: params.locale ?? "vi",
  });
}

/** Reviewer asked for missing paperwork; the applicant can edit and resubmit. */
export function enqueueApplicationNeedsInfoEmail(params: {
  toEmail: string;
  organizationName: string;
  applicationCode: string;
  message: string;
  trackUrl: string;
  locale?: string;
}): Promise<void> {
  return enqueueJob("ORG_APPLICATION_NEEDS_INFO", {
    toEmail: params.toEmail,
    organizationName: params.organizationName,
    applicationCode: params.applicationCode,
    message: params.message,
    trackUrl: params.trackUrl,
    locale: params.locale ?? "vi",
  });
}

export function enqueueApplicationRejectedEmail(params: {
  toEmail: string;
  organizationName: string;
  applicationCode: string;
  rejectReason: string;
  locale?: string;
}): Promise<void> {
  return enqueueJob("ORG_APPLICATION_REJECTED", {
    toEmail: params.toEmail,
    organizationName: params.organizationName,
    applicationCode: params.applicationCode,
    rejectReason: params.rejectReason,
    locale: params.locale ?? "vi",
  });
}

/**
 * Asks one owner candidate to confirm. Carries a summary of the application so the person
 * knows exactly what they are agreeing to, including who else is on it.
 */
export function enqueueOwnerConfirmationRequestEmail(params: {
  toEmail: string;
  candidateName: string;
  organizationName: string;
  orgType: string;
  address: string;
  submitterEmail: string;
  otherOwners: string;
  isLegalRep: boolean;
  confirmUrl: string;
  expiresAt: Date;
  expiresInDays: number;
  /** Proposal to add owners to an existing organization, not a new registration. */
  isAddOwner?: boolean;
  locale?: string;
}): Promise<void> {
  return enqueueJob("ORG_OWNER_CONFIRMATION_REQUEST", {
    isAddOwner: params.isAddOwner ? "true" : "",
    toEmail: params.toEmail,
    candidateName: params.candidateName,
    organizationName: params.organizationName,
    orgType: params.orgType,
    address: params.address,
    submitterEmail: params.submitterEmail,
    otherOwners: params.otherOwners,
    isLegalRep: params.isLegalRep ? "true" : "",
    confirmUrl: params.confirmUrl,
    expiresAt: params.expiresAt.toISOString().slice(0, 10),
    expiresInDays: String(params.expiresInDays),
    locale: params.locale ?? "vi",
  });
}

/** Tells the submitter that a candidate pressed "I'm not involved". */
export function enqueueOwnerDeclinedEmail(params: {
  toEmail: string;
  organizationName: string;
  ownerEmail: string;
  reason: string;
  trackUrl: string;
  locale?: string;
}): Promise<void> {
  return enqueueJob("ORG_OWNER_DECLINED", {
    toEmail: params.toEmail,
    organizationName: params.organizationName,
    ownerEmail: params.ownerEmail,
    reason: params.reason,
    trackUrl: params.trackUrl,
    locale: params.locale ?? "vi",
  });
}

/** Tells the submitter that one or more candidates let the confirmation link expire. */
export function enqueueOwnerConfirmationExpiredEmail(params: {
  toEmail: string;
  organizationName: string;
  ownerEmails: string;
  trackUrl: string;
  locale?: string;
}): Promise<void> {
  return enqueueJob("ORG_OWNER_CONFIRMATION_EXPIRED", {
    toEmail: params.toEmail,
    organizationName: params.organizationName,
    ownerEmails: params.ownerEmails,
    trackUrl: params.trackUrl,
    locale: params.locale ?? "vi",
  });
}

/**
 * Owners who already confirmed hear that the application was withdrawn. Silence would leave
 * them wondering why nothing happened after they agreed.
 */
export function enqueueApplicationWithdrawnNoticeEmail(params: {
  toEmail: string;
  organizationName: string;
  submitterEmail: string;
  locale?: string;
}): Promise<void> {
  return enqueueJob("ORG_APPLICATION_WITHDRAWN_NOTICE", {
    toEmail: params.toEmail,
    organizationName: params.organizationName,
    submitterEmail: params.submitterEmail,
    locale: params.locale ?? "vi",
  });
}

/**
 * First-password link for an owner who had no Ecolink account. Deliberately a link, not a
 * temporary password: a password mailed in plain text lives in that inbox forever.
 */
export function enqueueAccountActivationEmail(params: {
  toEmail: string;
  fullName: string;
  organizationName: string;
  activationUrl: string;
  expiresInHours: number;
  locale?: string;
}): Promise<void> {
  return enqueueJob("ACCOUNT_ACTIVATION", {
    toEmail: params.toEmail,
    fullName: params.fullName,
    organizationName: params.organizationName,
    activationUrl: params.activationUrl,
    expiresInHours: String(params.expiresInHours),
    locale: params.locale ?? "vi",
  });
}

/**
 * For an owner who already had an account. Never a password-reset link: sending one to
 * someone using their account normally is indistinguishable from phishing.
 */
export function enqueueOwnerAttachedEmail(params: {
  toEmail: string;
  fullName: string;
  organizationName: string;
  isLegalRep: boolean;
  manageUrl: string;
  locale?: string;
}): Promise<void> {
  return enqueueJob("ORG_OWNER_ATTACHED", {
    toEmail: params.toEmail,
    fullName: params.fullName,
    organizationName: params.organizationName,
    isLegalRep: params.isLegalRep ? "true" : "",
    manageUrl: params.manageUrl,
    locale: params.locale ?? "vi",
  });
}
