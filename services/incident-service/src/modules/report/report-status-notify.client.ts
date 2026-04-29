import axios from "axios";

interface SuccessEnvelope<T> {
  success: boolean;
  data?: T;
}

/**
 * Enqueues an in-app (website) notification to the report owner when status changes.
 */
export async function enqueueReportStatusWebsiteNotification(params: {
  userId: string;
  reportId: string;
  reportTitle: string;
  status: string;
}): Promise<void> {
  const baseURL = process.env.NOTIFICATION_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_NOTIFICATION_API_KEY?.trim();
  if (!baseURL || !key) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[incident-service] NOTIFICATION_SERVICE_URL or INTERNAL_NOTIFICATION_API_KEY not set; skipping report status notification",
      );
    }
    return;
  }

  const client = axios.create({
    baseURL: baseURL.replace(/\/$/, ""),
    timeout: 10_000,
    headers: { "x-internal-api-key": key },
  });

  const { data } = await client.post<SuccessEnvelope<{ accepted: boolean }>>(
    "/api/v1/notifications/jobs",
    {
      type: "website",
      kind: "REPORT_STATUS",
      userId: params.userId,
      payload: {
        reportId: params.reportId,
        reportTitle: params.reportTitle,
        status: params.status,
      },
    },
  );

  if (!data?.success) {
    throw new Error("Notification service rejected report status job");
  }
}

