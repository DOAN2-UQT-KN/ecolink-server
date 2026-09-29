import { Prisma } from "@prisma/client";
import {
  CAMPAIGN_IN_REVIEW_QUEUE_STATUSES,
  CAMPAIGN_OPEN_STATUSES,
  CAMPAIGN_PENDING_LIMIT_PER_ORG,
  CAMPAIGN_UNVERIFIED_MAX_DIFFICULTY,
  CAMPAIGN_UNVERIFIED_MAX_OPEN,
  CampaignCreateBlockReason,
  type CampaignCreateBlockReasonValue,
  OrgPermission,
  hasOrgPermission,
} from "@da2/constants";
import prisma from "../../config/prisma.client";
import { GlobalStatus } from "../../constants/status.enum";
import { HttpError, HTTP_STATUS } from "../../constants/http-status";
import { organizationMemberRepository } from "../organization/organization_member.repository";

type Db = Prisma.TransactionClient | typeof prisma;

export interface CampaignCreateEligibility {
  organizationId: string;
  /** The "create campaign" button works. */
  canCreate: boolean;
  /** Hide the button altogether (org admins and plain members). */
  hidden: boolean;
  reasons: CampaignCreateBlockReasonValue[];
  isVerified: boolean;
  /** Highest difficulty level allowed; null = any. */
  maxDifficulty: number | null;
  openCount: number;
  openLimit: number | null;
  reviewQueueCount: number;
  reviewQueueLimit: number;
}

interface OrgTrust {
  id: string;
  status: number;
  trustTier: string;
  tickSuspended: boolean;
}

/** Blue tick: verified tier and not suspended (same rule as the client badge). */
export function isOrganizationVerified(org: Pick<OrgTrust, "trustTier" | "tickSuspended">) {
  return org.trustTier === "VERIFIED" && !org.tickSuspended;
}

/** Pure part of the rules in spec 1.1. */
export function computeCreateEligibility(args: {
  org: OrgTrust;
  role: string | null;
  openCount: number;
  reviewQueueCount: number;
}): CampaignCreateEligibility {
  const { org, role } = args;
  const isVerified = isOrganizationVerified(org);
  const reasons: CampaignCreateBlockReasonValue[] = [];
  const hidden = !hasOrgPermission(role, OrgPermission.CAMPAIGN_CREATE);
  if (hidden) reasons.push(CampaignCreateBlockReason.NO_PERMISSION);
  if (org.status !== GlobalStatus._STATUS_ACTIVE) {
    reasons.push(CampaignCreateBlockReason.ORG_LOCKED);
  }
  if (args.reviewQueueCount >= CAMPAIGN_PENDING_LIMIT_PER_ORG) {
    reasons.push(CampaignCreateBlockReason.REVIEW_QUEUE_FULL);
  }
  if (!isVerified && args.openCount >= CAMPAIGN_UNVERIFIED_MAX_OPEN) {
    reasons.push(CampaignCreateBlockReason.UNVERIFIED_OPEN_LIMIT);
  }
  return {
    organizationId: org.id,
    canCreate: reasons.length === 0,
    hidden,
    reasons,
    isVerified,
    maxDifficulty: isVerified ? null : CAMPAIGN_UNVERIFIED_MAX_DIFFICULTY,
    openCount: args.openCount,
    openLimit: isVerified ? null : CAMPAIGN_UNVERIFIED_MAX_OPEN,
    reviewQueueCount: args.reviewQueueCount,
    reviewQueueLimit: CAMPAIGN_PENDING_LIMIT_PER_ORG,
  };
}

export class CampaignEligibilityService {
  /**
   * `excludeCampaignId` leaves out the campaign being submitted, which may already count in
   * the review queue (a resubmission).
   */
  async get(
    userId: string,
    organizationId: string,
    options: { db?: Db; excludeCampaignId?: string } = {},
  ): Promise<CampaignCreateEligibility> {
    const db = options.db ?? prisma;
    const org = await db.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: { id: true, status: true, trustTier: true, tickSuspended: true },
    });
    if (!org) {
      throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"));
    }
    const notThis = options.excludeCampaignId
      ? { id: { not: options.excludeCampaignId } }
      : {};
    const [role, openCount, reviewQueueCount] = await Promise.all([
      organizationMemberRepository.findActiveRole(organizationId, userId),
      db.campaign.count({
        where: {
          organizationId,
          deletedAt: null,
          status: { in: [...CAMPAIGN_OPEN_STATUSES] },
          ...notThis,
        },
      }),
      db.campaign.count({
        where: {
          organizationId,
          deletedAt: null,
          status: { in: [...CAMPAIGN_IN_REVIEW_QUEUE_STATUSES] },
          ...notThis,
        },
      }),
    ]);
    return computeCreateEligibility({ org, role, openCount, reviewQueueCount });
  }

  /** Creating a draft only needs the permission and an organization that is not locked. */
  async assertCanCreateDraft(userId: string, organizationId: string): Promise<void> {
    const e = await this.get(userId, organizationId);
    if (e.hidden) throw new HttpError(HTTP_STATUS.ORG_PERMISSION_DENIED);
    if (e.reasons.includes(CampaignCreateBlockReason.ORG_LOCKED)) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_CREATE_NOT_ALLOWED, {
        reasons: e.reasons,
      });
    }
  }

  /**
   * Sending for review re-checks every limit, inside the submit transaction. The submitter only
   * needs to manage the campaign, so the permission reason is ignored here (a campaign manager
   * without CAMPAIGN_CREATE may still submit a campaign they were given).
   */
  async assertCanSubmit(
    tx: Prisma.TransactionClient,
    userId: string,
    organizationId: string,
    campaignId: string,
  ): Promise<CampaignCreateEligibility> {
    const e = await this.get(userId, organizationId, {
      db: tx,
      excludeCampaignId: campaignId,
    });
    const blocking = e.reasons.filter(
      (r) => r !== CampaignCreateBlockReason.NO_PERMISSION,
    );
    if (blocking.length > 0) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_CREATE_NOT_ALLOWED, {
        reasons: blocking,
      });
    }
    return e;
  }
}

export const campaignEligibilityService = new CampaignEligibilityService();
