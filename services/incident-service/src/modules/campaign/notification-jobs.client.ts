import axios from "axios";

interface SuccessEnvelope<T> {
  success: boolean;
  data?: T;
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
}

/** In-app: org members when a new campaign is published. */
export async function enqueueCampaignCreatedWebsiteNotification(params: {
  userId: string;
  organizationName: string;
  campaignTitle: string;
  campaignId: string;
  organizationId: string;
}): Promise<void> {
  await postWebsiteNotificationJob({
    kind: "CAMPAIGN_CREATED",
    userId: params.userId,
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
  await postWebsiteNotificationJob({
    kind: "CAMPAIGN_DONE",
    userId: params.userId,
    payload: {
      campaignName: params.campaignName,
      campaignId: params.campaignId,
    },
  });
}

/** In-app: admins — a manager submitted the campaign for final completion approval. */
export async function enqueueCampaignCompletionPendingAdminWebsiteNotification(params: {
  userId: string;
  campaignTitle: string;
  campaignId: string;
}): Promise<void> {
  await postWebsiteNotificationJob({
    kind: "CAMPAIGN_COMPLETION_PENDING_ADMIN",
    userId: params.userId,
    payload: {
      campaignTitle: params.campaignTitle,
      campaignId: params.campaignId,
    },
  });
}

/** In-app: campaign managers — admin rejected the completion request; campaign is back in review. */
export async function enqueueCampaignCompletionRejectedByAdminWebsiteNotification(params: {
  userId: string;
  campaignTitle: string;
  campaignId: string;
}): Promise<void> {
  await postWebsiteNotificationJob({
    kind: "CAMPAIGN_COMPLETION_REJECTED_BY_ADMIN",
    userId: params.userId,
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
  await postWebsiteNotificationJob({
    kind: "CAMPAIGN_SUBMISSION_PENDING_REVIEW",
    userId: params.userId,
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
  await postWebsiteNotificationJob({
    kind: "CAMPAIGN_SUBMISSION_APPROVED",
    userId: params.userId,
    payload: {
      campaignTitle: params.campaignTitle,
      campaignId: params.campaignId,
      submissionId: params.submissionId,
    },
  });
}

/**
 * In-app: nearby citizens — asked to open the campaign and cast a community vote (up/down).
 */
export async function enqueueCampaignVerifyInviteNotification(params: {
  userId: string;
  campaignTitle: string;
  campaignId: string;
}): Promise<void> {
  await postWebsiteNotificationJob({
    kind: "CAMPAIGN_VERIFY_INVITE",
    userId: params.userId,
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

  await postWebsiteNotificationJob({
    kind: "VOLUNTEER_REQUEST",
    userId: params.userId,
    payload,
  });
}
