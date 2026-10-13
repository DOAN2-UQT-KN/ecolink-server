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

async function postWebsiteNotificationJob(params: {
  kind: string;
  userId: string;
  payload: Record<string, string>;
}): Promise<void> {
  const baseURL = process.env.NOTIFICATION_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_NOTIFICATION_API_KEY?.trim();
  if (!baseURL || !key) {
    console.warn(
      "[incident-service] NOTIFICATION_SERVICE_URL or INTERNAL_NOTIFICATION_API_KEY not set; skipping notification job",
    );
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
      throw new Error(`Notification service rejected job (kind=${params.kind})`);
    }
  });
}

/** Enqueue the same in-app notification to many users (respects notification prefs). */
export async function enqueueWebsiteNotificationsToUsers(params: {
  kind: string;
  userIds: string[];
  payload: Record<string, string>;
}): Promise<void> {
  const enabled = await filterUserIdsForNotificationKind({
    userIds: params.userIds,
    kind: params.kind,
  });
  if (enabled.length === 0) {
    return;
  }
  await Promise.all(
    enabled.map((userId) =>
      postWebsiteNotificationJob({
        kind: params.kind,
        userId,
        payload: params.payload,
      }),
    ),
  );
}

/** In-app: org members when a new campaign is published. */
export async function enqueueCampaignCreatedWebsiteNotification(params: {
  userId: string;
  organizationName: string;
  campaignTitle: string;
  campaignId: string;
  organizationId: string;
}): Promise<void> {
  await enqueueWebsiteNotificationsToUsers({
    kind: "CAMPAIGN_CREATED",
    userIds: [params.userId],
    payload: {
      organizationName: params.organizationName,
      campaignTitle: params.campaignTitle,
      campaignId: params.campaignId,
      organizationId: params.organizationId,
    },
  });
}

/** In-app: approved volunteers when a campaign is marked completed. */
export async function enqueueCampaignDoneWebsiteNotification(params: {
  userId: string;
  campaignName: string;
  campaignId: string;
}): Promise<void> {
  await enqueueWebsiteNotificationsToUsers({
    kind: "CAMPAIGN_DONE",
    userIds: [params.userId],
    payload: {
      campaignName: params.campaignName,
      campaignId: params.campaignId,
    },
  });
}

/** In-app: organization owner — admin rejected the completion request; campaign is active again. */
export async function enqueueCampaignCompletionRejectedByAdminWebsiteNotification(params: {
  userId: string;
  campaignTitle: string;
  campaignId: string;
  rejectReason: string;
}): Promise<void> {
  await enqueueWebsiteNotificationsToUsers({
    kind: "CAMPAIGN_COMPLETION_REJECTED_BY_ADMIN",
    userIds: [params.userId],
    payload: {
      campaignTitle: params.campaignTitle,
      campaignId: params.campaignId,
      rejectReason: params.rejectReason,
    },
  });
}

/** In-app: organization owner — admin approved campaign completion. */
export async function enqueueCampaignCompletionApprovedByAdminWebsiteNotification(params: {
  userId: string;
  campaignTitle: string;
  campaignId: string;
}): Promise<void> {
  await enqueueWebsiteNotificationsToUsers({
    kind: "CAMPAIGN_COMPLETION_APPROVED_BY_ADMIN",
    userIds: [params.userId],
    payload: {
      campaignTitle: params.campaignTitle,
      campaignId: params.campaignId,
    },
  });
}

/** In-app: platform reviewers — a manager submitted campaign results for approval. */
export async function enqueueCampaignSubmissionPendingReviewNotification(params: {
  userId: string;
  campaignTitle: string;
  campaignId: string;
  submissionId: string;
}): Promise<void> {
  await enqueueWebsiteNotificationsToUsers({
    kind: "CAMPAIGN_SUBMISSION_PENDING_REVIEW",
    userIds: [params.userId],
    payload: {
      campaignTitle: params.campaignTitle,
      campaignId: params.campaignId,
      submissionId: params.submissionId,
    },
  });
}

/** In-app: submitter — their submission was approved. */
export async function enqueueCampaignSubmissionApprovedNotification(params: {
  userId: string;
  campaignTitle: string;
  campaignId: string;
  submissionId: string;
}): Promise<void> {
  await enqueueWebsiteNotificationsToUsers({
    kind: "CAMPAIGN_SUBMISSION_APPROVED",
    userIds: [params.userId],
    payload: {
      campaignTitle: params.campaignTitle,
      campaignId: params.campaignId,
      submissionId: params.submissionId,
    },
  });
}

/**
 * In-app: nearby citizens — campaign approved; open and join as volunteers.
 */
export async function enqueueCampaignVerifyInviteNotification(params: {
  userId: string;
  campaignTitle: string;
  campaignId: string;
}): Promise<void> {
  await enqueueWebsiteNotificationsToUsers({
    kind: "CAMPAIGN_VERIFY_INVITE",
    userIds: [params.userId],
    payload: {
      campaignTitle: params.campaignTitle,
      campaignId: params.campaignId,
    },
  });
}

/**
 * In-app: nearby citizens — campaign submitted for completion; verify clean / not clean.
 */
export async function enqueueCampaignCompletionVerifyInviteNotification(params: {
  userId: string;
  campaignTitle: string;
  campaignId: string;
}): Promise<void> {
  await enqueueWebsiteNotificationsToUsers({
    kind: "CAMPAIGN_COMPLETION_VERIFY_INVITE",
    userIds: [params.userId],
    payload: {
      campaignTitle: params.campaignTitle,
      campaignId: params.campaignId,
    },
  });
}

/**
 * In-app: campaign managers or org owner when someone requests to join.
 * Templates use `reportTitle` for the resource name (campaign title or organization name).
 */
export async function enqueueVolunteerRequestWebsiteNotification(params: {
  userId: string;
  volunteerName: string;
  /** Display name of campaign or organization (template variable `reportTitle`). */
  reportTitle: string;
  campaignId?: string;
  organizationId?: string;
  organizationSlug?: string;
}): Promise<void> {
  const payload: Record<string, string> = {
    volunteerName: params.volunteerName,
    reportTitle: params.reportTitle,
  };
  if (params.campaignId) {
    payload.campaignId = params.campaignId;
  }
  if (params.organizationId) {
    payload.organizationId = params.organizationId;
  }
  if (params.organizationSlug) {
    payload.organizationSlug = params.organizationSlug;
  }

  await enqueueWebsiteNotificationsToUsers({
    kind: "VOLUNTEER_REQUEST",
    userIds: [params.userId],
    payload,
  });
}

/**
 * In-app: volunteer whose join request was approved (campaign or organization).
 * Templates use `reportTitle` for the resource name.
 */
export async function enqueueVolunteerApprovedWebsiteNotification(params: {
  userId: string;
  /** Display name of campaign or organization (template variable `reportTitle`). */
  reportTitle: string;
  campaignId?: string;
  organizationId?: string;
  organizationSlug?: string;
}): Promise<void> {
  const payload: Record<string, string> = {
    reportTitle: params.reportTitle,
  };
  if (params.campaignId) {
    payload.campaignId = params.campaignId;
  }
  if (params.organizationId) {
    payload.organizationId = params.organizationId;
  }
  if (params.organizationSlug) {
    payload.organizationSlug = params.organizationSlug;
  }

  await enqueueWebsiteNotificationsToUsers({
    kind: "VOLUNTEER_APPROVED",
    userIds: [params.userId],
    payload,
  });
}

/**
 * In-app: volunteer whose join request was declined (campaign or organization).
 * Templates use `reportTitle` for the resource name.
 */
export async function enqueueVolunteerRejectedWebsiteNotification(params: {
  userId: string;
  /** Display name of campaign or organization (template variable `reportTitle`). */
  reportTitle: string;
  campaignId?: string;
  organizationId?: string;
  organizationSlug?: string;
}): Promise<void> {
  const payload: Record<string, string> = {
    reportTitle: params.reportTitle,
  };
  if (params.campaignId) {
    payload.campaignId = params.campaignId;
  }
  if (params.organizationId) {
    payload.organizationId = params.organizationId;
  }
  if (params.organizationSlug) {
    payload.organizationSlug = params.organizationSlug;
  }

  await enqueueWebsiteNotificationsToUsers({
    kind: "VOLUNTEER_REJECTED",
    userIds: [params.userId],
    payload,
  });
}

/** In-app: organization owner — admin approved the organization. */
export async function enqueueOrganizationApprovedWebsiteNotification(params: {
  userId: string;
  organizationName: string;
  organizationId: string;
  organizationSlug?: string;
}): Promise<void> {
  const payload: Record<string, string> = {
    organizationName: params.organizationName,
    organizationId: params.organizationId,
  };
  if (params.organizationSlug) {
    payload.organizationSlug = params.organizationSlug;
  }
  await enqueueWebsiteNotificationsToUsers({
    kind: "ORGANIZATION_APPROVED",
    userIds: [params.userId],
    payload,
  });
}

/** In-app: organization owner — admin banned the organization. */
export async function enqueueOrganizationRejectedWebsiteNotification(params: {
  userId: string;
  organizationName: string;
  organizationId: string;
  rejectReason: string;
  organizationSlug?: string;
}): Promise<void> {
  const payload: Record<string, string> = {
    organizationName: params.organizationName,
    organizationId: params.organizationId,
    rejectReason: params.rejectReason,
  };
  if (params.organizationSlug) {
    payload.organizationSlug = params.organizationSlug;
  }
  await enqueueWebsiteNotificationsToUsers({
    kind: "ORGANIZATION_REJECTED",
    userIds: [params.userId],
    payload,
  });
}
