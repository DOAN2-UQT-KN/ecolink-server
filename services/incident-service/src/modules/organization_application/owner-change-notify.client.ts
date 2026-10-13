import { ApplicationType } from "@da2/constants";
import { enqueueWebsiteNotificationsToUsers } from "../campaign/notification-jobs.client";
import { enqueueEmailToUser } from "./organization-application-notify.client";

/** Payload fields every owner-change notice shares. */
export interface OwnerChangeNoticeBase {
  type: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  /** Who is added / removed / receiving the role, already joined for display. */
  subjectNames: string;
  demoteTo: string | null;
  manageUrl: string;
}

function typeFlags(type: string): Record<string, string> {
  return {
    changeType: type,
    isAdd: type === ApplicationType.ADD_OWNER ? "true" : "",
    isRemove: type === ApplicationType.REMOVE_OWNER ? "true" : "",
  };
}

function basePayload(notice: OwnerChangeNoticeBase): Record<string, string> {
  return {
    ...typeFlags(notice.type),
    organizationId: notice.organizationId,
    organizationName: notice.organizationName,
    organizationSlug: notice.organizationSlug,
    subjectNames: notice.subjectNames,
    demoteTo: notice.demoteTo ?? "",
    manageUrl: notice.manageUrl,
  };
}

function warn(what: string) {
  return (err: unknown) => console.warn(`[owner-change] failed to send ${what}`, err);
}

/** Each co-owner whose approval is needed: in-app and by email (the answer has a deadline). */
export function notifyApprovalRequested(
  approverIds: string[],
  notice: OwnerChangeNoticeBase & { proposerName: string; reason: string; expiresAt: Date },
): void {
  if (approverIds.length === 0) return;
  const payload = {
    ...basePayload(notice),
    proposerName: notice.proposerName,
    reason: notice.reason,
    expiresAt: notice.expiresAt.toISOString().slice(0, 10),
  };
  void enqueueWebsiteNotificationsToUsers({
    kind: "ORG_OWNER_CHANGE_APPROVAL_REQUEST",
    userIds: approverIds,
    payload,
  }).catch(warn("an approval request"));
  for (const userId of approverIds) {
    void enqueueEmailToUser("ORG_OWNER_CHANGE_APPROVAL_REQUEST", userId, payload).catch(
      warn("an approval request email"),
    );
  }
}

/** The owner proposed for removal hears it from the start, not only once it is done. */
export function notifyRemovalProposed(
  targetUserId: string,
  notice: OwnerChangeNoticeBase & {
    proposerName: string;
    reason: string;
    needsApproval: boolean;
  },
): void {
  const payload = {
    ...basePayload(notice),
    proposerName: notice.proposerName,
    reason: notice.reason,
    needsApproval: notice.needsApproval ? "true" : "",
  };
  void enqueueWebsiteNotificationsToUsers({
    kind: "ORG_OWNER_REMOVAL_PROPOSED",
    userIds: [targetUserId],
    payload,
  }).catch(warn("a removal notice"));
  void enqueueEmailToUser("ORG_OWNER_REMOVAL_PROPOSED", targetUserId, payload).catch(
    warn("a removal notice email"),
  );
}

export type OwnerChangeOutcome = "approved" | "rejected" | "withdrawn";

/** Final outcome, to the proposer and the people the change was about. */
export function notifyDecided(
  userIds: string[],
  notice: OwnerChangeNoticeBase & { outcome: OwnerChangeOutcome; reason: string },
): void {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  void enqueueWebsiteNotificationsToUsers({
    kind: "ORG_OWNER_CHANGE_DECIDED",
    userIds: unique,
    payload: {
      ...basePayload(notice),
      approved: notice.outcome === "approved" ? "true" : "",
      rejected: notice.outcome === "rejected" ? "true" : "",
      withdrawn: notice.outcome === "withdrawn" ? "true" : "",
      reason: notice.reason,
    },
  }).catch(warn("an outcome notice"));
}

/** The remaining owners, when one steps down to a lesser role or leaves. */
export function notifyOwnerLeft(
  ownerIds: string[],
  params: {
    organizationId: string;
    organizationName: string;
    organizationSlug: string;
    memberName: string;
    newRole: string | null;
  },
): void {
  if (ownerIds.length === 0) return;
  void enqueueWebsiteNotificationsToUsers({
    kind: "ORG_OWNER_LEFT",
    userIds: ownerIds,
    payload: {
      organizationId: params.organizationId,
      organizationName: params.organizationName,
      organizationSlug: params.organizationSlug,
      memberName: params.memberName,
      newRole: params.newRole ?? "",
    },
  }).catch(warn("an owner-left notice"));
}
