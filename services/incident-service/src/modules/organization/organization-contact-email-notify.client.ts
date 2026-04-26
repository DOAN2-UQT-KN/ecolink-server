import axios from "axios";

interface SuccessEnvelope<T> {
  success: boolean;
  data?: T;
}

/**
 * Enqueues organization contact verification email via notification-service.
 */
export async function enqueueOrganizationContactVerificationEmail(params: {
  toEmail: string;
  organizationName: string;
  verifyUrl: string;
  organizationId: string;
  ownerUserId: string;
}): Promise<void> {
  const baseURL = process.env.NOTIFICATION_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_NOTIFICATION_API_KEY?.trim();
  if (!baseURL || !key) {
    console.warn(
      "[incident-service] NOTIFICATION_SERVICE_URL or INTERNAL_NOTIFICATION_API_KEY not set; skipping contact verification email",
    );
    return;
  }

  const appName = process.env.APP_NAME?.trim() || "DA2";

  const client = axios.create({
    baseURL: baseURL.replace(/\/$/, ""),
    timeout: 10_000,
    headers: { "x-internal-api-key": key },
  });

  const { data } = await client.post<SuccessEnvelope<{ jobId: string }>>(
    "/api/v1/notifications/jobs",
    {
      type: "email",
      kind: "ORGANIZATION_CONTACT_VERIFY",
      payload: {
        toEmail: params.toEmail,
        organizationName: params.organizationName,
        verifyUrl: params.verifyUrl,
        appName,
        organizationId: params.organizationId,
        ownerUserId: params.ownerUserId,
      },
    },
  );

  if (!data?.success) {
    throw new Error("Notification service rejected organization contact email job");
  }
}
