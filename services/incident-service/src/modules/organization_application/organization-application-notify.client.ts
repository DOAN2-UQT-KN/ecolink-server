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
 * Link that lets the organization set the first password of its ORG account.
 * Deliberately a link, not a temporary password: a password mailed in plain text lives in
 * that inbox forever.
 */
export function enqueueOrgAccountActivationEmail(params: {
  toEmail: string;
  organizationName: string;
  activationUrl: string;
  expiresInHours: number;
  locale?: string;
}): Promise<void> {
  return enqueueJob("ORG_ACCOUNT_ACTIVATION", {
    toEmail: params.toEmail,
    organizationName: params.organizationName,
    activationUrl: params.activationUrl,
    expiresInHours: String(params.expiresInHours),
    locale: params.locale ?? "vi",
  });
}
