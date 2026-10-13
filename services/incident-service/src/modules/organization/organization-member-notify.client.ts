import { enqueueWebsiteNotificationsToUsers } from "../campaign/notification-jobs.client";

/** In-app: a member's role was changed, or they were removed from the organization. */
export function enqueueOrgMembershipChangedWebsiteNotification(params: {
  userId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role?: string;
  removed?: boolean;
}): Promise<void> {
  return enqueueWebsiteNotificationsToUsers({
    kind: "ORG_MEMBERSHIP_CHANGED",
    userIds: [params.userId],
    payload: {
      organizationId: params.organizationId,
      organizationName: params.organizationName,
      organizationSlug: params.organizationSlug,
      role: params.role ?? "",
      removed: params.removed ? "true" : "",
    },
  });
}

/** In-app: someone without approval rights invited a person; approvers must decide. */
export function enqueueOrgInvitationPendingWebsiteNotification(params: {
  userIds: string[];
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  inviterName: string;
  inviteeName: string;
}): Promise<void> {
  return enqueueWebsiteNotificationsToUsers({
    kind: "ORG_INVITATION_PENDING",
    userIds: params.userIds,
    payload: {
      organizationId: params.organizationId,
      organizationName: params.organizationName,
      organizationSlug: params.organizationSlug,
      inviterName: params.inviterName,
      inviteeName: params.inviteeName,
    },
  });
}

/** In-app: tells the inviter that an approver rejected their invitation. */
export function enqueueOrgInvitationRejectedWebsiteNotification(params: {
  userId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  inviteeName: string;
}): Promise<void> {
  return enqueueWebsiteNotificationsToUsers({
    kind: "ORG_INVITATION_REJECTED",
    userIds: [params.userId],
    payload: {
      organizationId: params.organizationId,
      organizationName: params.organizationName,
      organizationSlug: params.organizationSlug,
      inviteeName: params.inviteeName,
    },
  });
}
