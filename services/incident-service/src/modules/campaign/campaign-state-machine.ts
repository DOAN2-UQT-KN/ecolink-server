import { Prisma } from "@prisma/client";
import { CampaignStatus } from "@da2/constants";
import { HttpError, HTTP_STATUS } from "../../constants/http-status";

/** Who drives a transition. Managers include the creator and the organization's owners. */
export type CampaignActorRole = "manager" | "admin" | "system";

export type CampaignTransitionEvent =
  | "submit"
  | "resubmit"
  | "approve"
  | "edit_major"
  | "start"
  | "request_revision"
  | "block"
  | "ban"
  | "expire"
  | "cancel_org_locked"
  | "cancel"
  | "submit_completion"
  | "approve_completion"
  | "reject_completion";

interface TransitionRule {
  event: CampaignTransitionEvent;
  from: readonly number[];
  to: number;
  actors: readonly CampaignActorRole[];
  reasonRequired: boolean;
}

/**
 * Every allowed status change of a campaign. Anything not listed here is refused, so a
 * status can only move through `transitionCampaign`.
 */
export const CAMPAIGN_TRANSITIONS: readonly TransitionRule[] = [
  {
    event: "submit",
    from: [CampaignStatus.DRAFT],
    to: CampaignStatus.PENDING_REVIEW,
    actors: ["manager"],
    reasonRequired: false,
  },
  {
    event: "resubmit",
    from: [CampaignStatus.NEEDS_REVISION],
    to: CampaignStatus.PENDING_REVIEW,
    actors: ["manager"],
    reasonRequired: false,
  },
  {
    event: "approve",
    from: [CampaignStatus.PENDING_REVIEW],
    to: CampaignStatus.UPCOMING,
    actors: ["admin"],
    reasonRequired: false,
  },
  {
    // Spec 3.5: an important field of an approved campaign changed; volunteers keep their place.
    event: "edit_major",
    from: [CampaignStatus.UPCOMING],
    to: CampaignStatus.PENDING_REVIEW,
    actors: ["manager"],
    reasonRequired: false,
  },
  {
    // The lifecycle job, once the first shift has started.
    event: "start",
    from: [CampaignStatus.UPCOMING],
    to: CampaignStatus.ACTIVE,
    actors: ["system"],
    reasonRequired: false,
  },
  {
    event: "request_revision",
    from: [CampaignStatus.PENDING_REVIEW],
    to: CampaignStatus.NEEDS_REVISION,
    actors: ["admin"],
    reasonRequired: true,
  },
  {
    event: "block",
    from: [CampaignStatus.PENDING_REVIEW, CampaignStatus.NEEDS_REVISION],
    to: CampaignStatus.BLOCKED,
    actors: ["admin"],
    reasonRequired: true,
  },
  {
    // Ban of an approved campaign, before or after it started.
    event: "ban",
    from: [CampaignStatus.UPCOMING, CampaignStatus.ACTIVE],
    to: CampaignStatus.BLOCKED,
    actors: ["admin"],
    reasonRequired: true,
  },
  {
    event: "expire",
    from: [CampaignStatus.PENDING_REVIEW, CampaignStatus.NEEDS_REVISION],
    to: CampaignStatus.EXPIRED,
    actors: ["system"],
    reasonRequired: false,
  },
  {
    // Spec, exceptions: locking the organization cancels what was not approved yet.
    event: "cancel_org_locked",
    from: [
      CampaignStatus.DRAFT,
      CampaignStatus.PENDING_REVIEW,
      CampaignStatus.NEEDS_REVISION,
    ],
    to: CampaignStatus.CANCELLED,
    actors: ["admin"],
    reasonRequired: true,
  },
  {
    // Spec 3.6: the creator or an owner cancels an approved campaign, with a reason. Under review
    // again (12 / 19) only once approved; the service checks `approvedAt`.
    event: "cancel",
    from: [
      CampaignStatus.UPCOMING,
      CampaignStatus.ACTIVE,
      CampaignStatus.PENDING_REVIEW,
      CampaignStatus.NEEDS_REVISION,
    ],
    to: CampaignStatus.CANCELLED,
    actors: ["manager"],
    reasonRequired: true,
  },
  {
    event: "submit_completion",
    from: [CampaignStatus.ACTIVE, CampaignStatus.LEGACY_IN_REVIEW],
    to: CampaignStatus.PENDING_COMPLETION,
    actors: ["manager"],
    reasonRequired: false,
  },
  {
    event: "approve_completion",
    from: [CampaignStatus.PENDING_COMPLETION],
    to: CampaignStatus.COMPLETED,
    actors: ["admin"],
    reasonRequired: false,
  },
  {
    event: "reject_completion",
    from: [CampaignStatus.PENDING_COMPLETION],
    to: CampaignStatus.ACTIVE,
    actors: ["admin"],
    reasonRequired: true,
  },
];

export function findTransition(
  event: CampaignTransitionEvent,
): TransitionRule {
  const rule = CAMPAIGN_TRANSITIONS.find((t) => t.event === event);
  if (!rule) throw new Error(`Unknown campaign transition: ${event}`);
  return rule;
}

/** Throws 409 / 403 / 400 when `event` may not run from `fromStatus` for `actor`. */
export function assertTransitionAllowed(args: {
  event: CampaignTransitionEvent;
  fromStatus: number;
  actor: CampaignActorRole;
  reason?: string | null;
}): TransitionRule {
  const rule = findTransition(args.event);
  if (!rule.from.includes(args.fromStatus)) {
    throw new HttpError(HTTP_STATUS.CAMPAIGN_INVALID_TRANSITION);
  }
  if (!rule.actors.includes(args.actor)) {
    throw new HttpError(HTTP_STATUS.CAMPAIGN_PERMISSION_DENIED);
  }
  if (rule.reasonRequired && !args.reason?.trim()) {
    throw new HttpError(
      HTTP_STATUS.VALIDATION_ERROR.withMessage("A reason is required"),
    );
  }
  return rule;
}

/**
 * Moves a campaign along one transition inside `tx`: checks the rule, updates the status only
 * if nobody changed it meanwhile (compare-and-set), and writes the audit log row.
 * `data` carries the other columns to set together with the status.
 */
export async function transitionCampaign(
  tx: Prisma.TransactionClient,
  args: {
    campaignId: string;
    event: CampaignTransitionEvent;
    fromStatus: number;
    actor: CampaignActorRole;
    actorId: string | null;
    reason?: string | null;
    changes?: Prisma.InputJsonValue;
    data?: Omit<Prisma.CampaignUpdateManyMutationInput, "status">;
  },
): Promise<number> {
  const rule = assertTransitionAllowed(args);
  const reason = args.reason?.trim() || null;

  const result = await tx.campaign.updateMany({
    where: { id: args.campaignId, status: args.fromStatus, deletedAt: null },
    data: {
      ...(args.data ?? {}),
      status: rule.to,
      ...(args.actorId ? { updatedBy: args.actorId } : {}),
    },
  });
  if (result.count !== 1) {
    throw new HttpError(
      HTTP_STATUS.CAMPAIGN_INVALID_TRANSITION.withMessage(
        "The campaign changed meanwhile; reload and try again",
      ),
    );
  }

  await tx.campaignStatusLog.create({
    data: {
      campaignId: args.campaignId,
      type: "STATUS_CHANGE",
      event: rule.event,
      fromStatus: args.fromStatus,
      toStatus: rule.to,
      actorId: args.actorId,
      actorRole: args.actor,
      reason,
      ...(args.changes !== undefined ? { changes: args.changes } : {}),
    },
  });
  return rule.to;
}

/** Audit row for an edit that does not change the status (edits under review). */
export async function logCampaignEdit(
  tx: Prisma.TransactionClient,
  args: {
    campaignId: string;
    status: number;
    actorId: string;
    changes: Record<string, { from: unknown; to: unknown }>;
  },
): Promise<void> {
  if (Object.keys(args.changes).length === 0) return;
  await tx.campaignStatusLog.create({
    data: {
      campaignId: args.campaignId,
      type: "EDIT",
      event: "edit",
      fromStatus: args.status,
      toStatus: args.status,
      actorId: args.actorId,
      actorRole: "manager",
      changes: args.changes as Prisma.InputJsonValue,
    },
  });
}
