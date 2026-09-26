function frontendBaseUrl(): string {
  return (process.env.FRONTEND_APP_URL?.trim() || "http://localhost:3000").replace(
    /\/$/,
    "",
  );
}

export function buildAccountActivationUrl(token: string): string {
  return `${frontendBaseUrl()}/activate-account?token=${encodeURIComponent(token)}`;
}

/**
 * Mails a fresh activation link through notification-service (same `ACCOUNT_ACTIVATION` kind
 * incident-service sends after an approval). A missing configuration degrades to a warning:
 * the resend endpoint must not reveal anything, including an outage.
 */
export async function enqueueAccountActivationEmail(params: {
  toEmail: string;
  fullName: string;
  activationUrl: string;
  expiresInHours: number;
  locale?: string;
}): Promise<void> {
  const baseURL = process.env.NOTIFICATION_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_NOTIFICATION_API_KEY?.trim();
  if (!baseURL || !key) {
    console.warn(
      "[identity-service] NOTIFICATION_SERVICE_URL or INTERNAL_NOTIFICATION_API_KEY not set; skipping ACCOUNT_ACTIVATION email",
    );
    return;
  }

  const response = await fetch(
    `${baseURL.replace(/\/$/, "")}/api/v1/notifications/jobs`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-api-key": key,
      },
      body: JSON.stringify({
        type: "email",
        kind: "ACCOUNT_ACTIVATION",
        payload: {
          toEmail: params.toEmail,
          fullName: params.fullName,
          organizationName: "",
          activationUrl: params.activationUrl,
          expiresInHours: String(params.expiresInHours),
          locale: params.locale ?? "vi",
          appName: process.env.APP_NAME?.trim() || "DA2",
        },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Notification service rejected the ACCOUNT_ACTIVATION job (${response.status})`,
    );
  }
}
