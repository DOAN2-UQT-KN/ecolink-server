import axios from "axios";
import { filterUserIdsForNotificationKind } from "../organization/identity-user.client";
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

async function postReportWebsiteNotification(params: {
  kind: string;
  userId: string;
  payload: Record<string, string>;
}): Promise<void> {
  const baseURL = process.env.NOTIFICATION_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_NOTIFICATION_API_KEY?.trim();
  if (!baseURL || !key) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[incident-service] NOTIFICATION_SERVICE_URL or INTERNAL_NOTIFICATION_API_KEY not set; skipping report notification",
      );
    }
    return;
  }

  const enabled = await filterUserIdsForNotificationKind({
    userIds: [params.userId],
    kind: params.kind,
  });
  if (enabled.length === 0) {
    return;
  }

  await notificationCircuit().run(async () => {
    const client = axios.create({
      baseURL: baseURL.replace(/\/$/, ""),
      timeout: 10_000,
      headers: { "x-internal-api-key": key },
    });

    const { data } = await client.post<SuccessEnvelope<{ accepted: boolean }>>(
      "/api/v1/notifications/jobs",
      {
        type: "website",
        kind: params.kind,
        userId: params.userId,
        payload: params.payload,
      },
    );

    if (!data?.success) {
      throw new Error(
        `Notification service rejected ${params.kind} job`,
      );
    }
  });
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
  await postReportWebsiteNotification({
    kind: "REPORT_STATUS",
    userId: params.userId,
    payload: {
      reportId: params.reportId,
      reportTitle: params.reportTitle,
      status: params.status,
    },
  });
}

/** In-app: report owner — admin verified the incident. */
export async function enqueueReportApprovedWebsiteNotification(params: {
  userId: string;
  reportId: string;
  reportTitle: string;
}): Promise<void> {
  await postReportWebsiteNotification({
    kind: "REPORT_APPROVED",
    userId: params.userId,
    payload: {
      reportId: params.reportId,
      reportTitle: params.reportTitle,
    },
  });
}

/** In-app: report owner — admin banned the incident. */
export async function enqueueReportRejectedWebsiteNotification(params: {
  userId: string;
  reportId: string;
  reportTitle: string;
  rejectReason: string;
}): Promise<void> {
  await postReportWebsiteNotification({
    kind: "REPORT_REJECTED",
    userId: params.userId,
    payload: {
      reportId: params.reportId,
      reportTitle: params.reportTitle,
      rejectReason: params.rejectReason,
    },
  });
}

/** In-app: report owner — automatic verification sent the incident to moderator review. */
export async function enqueueReportInReviewWebsiteNotification(params: {
  userId: string;
  reportId: string;
  reportTitle: string;
}): Promise<void> {
  await postReportWebsiteNotification({
    kind: "REPORT_IN_REVIEW",
    userId: params.userId,
    payload: {
      reportId: params.reportId,
      reportTitle: params.reportTitle,
    },
  });
}
