import { Prisma } from "@prisma/client";
import {
  CAMPAIGN_DRAFT_TTL_DAYS,
  CAMPAIGN_MEETING_POINT_MAX,
  CAMPAIGN_PRE_APPROVAL_STATUSES,
  CAMPAIGN_REVISION_HOLD_DAYS,
  CampaignStatus,
  type CampaignRequirements,
} from "@da2/constants";
import prisma from "../../config/prisma.client";
import { ReportStatus } from "../../constants/status.enum";
import { HttpError, HTTP_STATUS } from "../../constants/http-status";
import { organizationRepository } from "../organization/organization.repository";
import { organizationMemberRepository } from "../organization/organization_member.repository";
import { rewardServiceClient } from "../reward/reward-service.client";
import { campaignAccessService, isPlatformAdmin } from "./campaign-access.service";
import { getCampaignAdminNotifyUserIds } from "./campaign-completion-admin-notify.config";
import { campaignEligibilityService } from "./campaign-eligibility.service";
import { campaignTitleNotificationPayload } from "./campaign-i18n";
import {
  transitionCampaign,
  type CampaignTransitionEvent,
} from "./campaign-state-machine";
import {
  validateCampaignForSubmit,
  withDefaultRequirements,
} from "./campaign-submit-validation";
import type {
  CampaignStatusLogResponse,
  MeetingPointInput,
} from "./campaign.dto";
import { CAMPAIGN_INCLUDE, type CampaignWithReports } from "./campaign.entity";
import { enqueueWebsiteNotificationsToUsers } from "./notification-jobs.client";

const DAY_MS = 24 * 60 * 60 * 1000;

type Tx = Prisma.TransactionClient;

/** A meeting point as stored, normalized from a request. */
export interface NormalizedMeetingPoint {
  name: string | null;
  latitude: number;
  longitude: number;
  detailAddress: string | null;
  radiusKm: number;
  gatherAt: Date | null;
  slots: number | null;
  leaderUserId: string | null;
  reportIds: string[];
}

/** What the admin compares between two submissions. */
export interface CampaignSnapshot {
  title: string;
  description: string | null;
  banner: string | null;
  startDate: string | null;
  endDate: string | null;
  difficulty: number;
  contactName: string | null;
  contactPhone: string | null;
  safetyNotes: string | null;
  requirements: CampaignRequirements | null;
  meetingPoints: Array<Omit<NormalizedMeetingPoint, "gatherAt"> & { gatherAt: string | null }>;
}

export type FieldDiff = Record<string, { from: unknown; to: unknown }>;

export type ReviewDecision = "approve" | "request_revision" | "block";

function uniqueIds(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

export function normalizeMeetingPoints(
  input: MeetingPointInput[],
  defaultLeaderId: string,
): NormalizedMeetingPoint[] {
  return input.map((p) => ({
    name: p.name?.trim() || null,
    latitude: Number(p.latitude),
    longitude: Number(p.longitude),
    detailAddress: p.detailAddress?.trim() || null,
    radiusKm: Number(p.radiusKm),
    gatherAt: p.gatherAt ? new Date(p.gatherAt) : null,
    slots: p.slots == null ? null : Number(p.slots),
    leaderUserId: p.leaderUserId?.trim() || defaultLeaderId,
    reportIds: uniqueIds(p.reportIds),
  }));
}

/**
 * The meeting points a create/update body asks for. Old clients send one location and a flat
 * `reportIds`; that becomes a single meeting point. Returns undefined when the body leaves the
 * meeting points untouched.
 */
export function meetingPointsFromRequest(
  request: {
    meetingPoints?: MeetingPointInput[];
    reportIds?: string[];
    latitude?: number | null;
    longitude?: number | null;
    radiusKm?: number | null;
    detailAddress?: string | null;
    startDate?: string | null;
  },
  defaultLeaderId: string,
): NormalizedMeetingPoint[] | undefined {
  if (request.meetingPoints !== undefined) {
    if (request.meetingPoints.length > CAMPAIGN_MEETING_POINT_MAX) {
      throw new HttpError(
        HTTP_STATUS.VALIDATION_ERROR.withMessage(
          `At most ${CAMPAIGN_MEETING_POINT_MAX} meeting points`,
        ),
      );
    }
    return normalizeMeetingPoints(request.meetingPoints, defaultLeaderId);
  }
  if (request.reportIds === undefined) return undefined;
  if (request.latitude == null || request.longitude == null) {
    throw new HttpError(
      HTTP_STATUS.VALIDATION_ERROR.withMessage(
        "latitude and longitude are required to attach waste points",
      ),
    );
  }
  return normalizeMeetingPoints(
    [
      {
        latitude: request.latitude,
        longitude: request.longitude,
        radiusKm: request.radiusKm ?? 1,
        detailAddress: request.detailAddress,
        gatherAt: request.startDate ?? null,
        reportIds: request.reportIds,
      },
    ],
    defaultLeaderId,
  );
}

function toSnapshot(campaign: CampaignWithReports): CampaignSnapshot {
  return {
    title: campaign.title,
    description: campaign.description,
    banner: campaign.banner,
    startDate: campaign.startDate?.toISOString() ?? null,
    endDate: campaign.endDate?.toISOString() ?? null,
    difficulty: campaign.difficulty,
    contactName: campaign.contactName,
    contactPhone: campaign.contactPhone,
    safetyNotes: campaign.safetyNotes,
    requirements: (campaign.requirements as CampaignRequirements | null) ?? null,
    meetingPoints: (campaign.meetingPoints ?? []).map((p) => ({
      name: p.name,
      latitude: p.latitude,
      longitude: p.longitude,
      detailAddress: p.detailAddress,
      radiusKm: p.radiusKm,
      gatherAt: p.gatherAt?.toISOString() ?? null,
      slots: p.slots,
      leaderUserId: p.leaderUserId,
      reportIds: p.reports.map((r) => r.reportId).sort(),
    })),
  };
}

/** JSON with object keys sorted, so a snapshot read back from JSONB compares equal. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );
}

/** Top-level fields whose value differs between two snapshots. */
export function diffSnapshots(
  before: Partial<CampaignSnapshot> | null | undefined,
  after: CampaignSnapshot,
): FieldDiff {
  const diff: FieldDiff = {};
  for (const key of Object.keys(after) as (keyof CampaignSnapshot)[]) {
    const from = before?.[key] ?? null;
    const to = after[key] ?? null;
    if (stableJson(from) !== stableJson(to)) {
      diff[key] = { from, to };
    }
  }
  return diff;
}

export class CampaignLifecycleService {
  async loadInTx(tx: Tx, id: string): Promise<CampaignWithReports> {
    const campaign = await tx.campaign.findFirst({
      where: { id, deletedAt: null },
      include: CAMPAIGN_INCLUDE,
    });
    if (!campaign) {
      throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"));
    }
    return campaign;
  }

  snapshotOf(campaign: CampaignWithReports): CampaignSnapshot {
    return toSnapshot(campaign);
  }

  /**
   * Reports a draft may pick: approved and free, or already locked by this campaign.
   * Throws 400 naming the ones that are not.
   */
  async assertReportsSelectable(
    db: Tx | typeof prisma,
    campaignId: string | null,
    reportIds: string[],
  ): Promise<void> {
    if (reportIds.length === 0) return;
    const rows = await db.report.findMany({
      where: {
        id: { in: reportIds },
        deletedAt: null,
        OR: [
          { campaignId: null, status: ReportStatus._STATUS_TODO },
          ...(campaignId ? [{ campaignId }] : []),
        ],
      },
      select: { id: true },
    });
    const ok = new Set(rows.map((r) => r.id));
    const bad = reportIds.filter((id) => !ok.has(id));
    if (bad.length > 0) {
      throw new HttpError(
        HTTP_STATUS.CAMPAIGN_REPORTS_TAKEN.withMessage(
          "Some waste points are not approved or already belong to another campaign",
        ),
        { reportIds: bad },
      );
    }
  }

  /** Replaces the meeting points of a campaign and which reports each one covers. */
  async replaceMeetingPoints(
    tx: Tx,
    campaignId: string,
    points: NormalizedMeetingPoint[],
    userId: string,
  ): Promise<void> {
    await tx.campaignMeetingPointReport.deleteMany({ where: { campaignId } });
    await tx.campaignMeetingPoint.updateMany({
      where: { campaignId, deletedAt: null },
      data: { deletedAt: new Date(), updatedBy: userId },
    });
    for (const [index, point] of points.entries()) {
      const created = await tx.campaignMeetingPoint.create({
        data: {
          campaignId,
          name: point.name,
          latitude: point.latitude,
          longitude: point.longitude,
          detailAddress: point.detailAddress,
          radiusKm: point.radiusKm,
          gatherAt: point.gatherAt,
          slots: point.slots,
          leaderUserId: point.leaderUserId,
          sortOrder: index,
          createdBy: userId,
          updatedBy: userId,
        },
      });
      if (point.reportIds.length > 0) {
        await tx.campaignMeetingPointReport.createMany({
          data: point.reportIds.map((reportId) => ({
            meetingPointId: created.id,
            reportId,
            campaignId,
          })),
        });
      }
    }
    // The campaign's own location mirrors the first meeting point, for maps and nearby invites.
    const first = points[0];
    if (first) {
      await tx.campaign.update({
        where: { id: campaignId },
        data: {
          latitude: first.latitude,
          longitude: first.longitude,
          radiusKm: first.radiusKm,
          detailAddress: first.detailAddress,
        },
      });
    }
  }

  /**
   * Makes the reports locked by the campaign (`campaign_id` + INPROCESS) match its meeting
   * points: releases the ones no longer wanted and locks the new ones with a compare-and-set.
   * A report another campaign took first fails the whole transaction with 409 and its id.
   */
  async syncReportLocks(tx: Tx, campaignId: string, userId: string): Promise<void> {
    const [links, locked] = await Promise.all([
      tx.campaignMeetingPointReport.findMany({
        where: { campaignId },
        select: { reportId: true },
      }),
      tx.report.findMany({
        where: { campaignId, deletedAt: null },
        select: { id: true },
      }),
    ]);
    const wanted = new Set(links.map((l) => l.reportId));
    const lockedIds = new Set(locked.map((r) => r.id));
    const toRelease = [...lockedIds].filter((id) => !wanted.has(id));
    const toLock = [...wanted].filter((id) => !lockedIds.has(id));

    if (toRelease.length > 0) {
      await tx.report.updateMany({
        where: { id: { in: toRelease }, campaignId },
        data: { campaignId: null, status: ReportStatus._STATUS_TODO, updatedBy: userId },
      });
    }
    if (toLock.length === 0) return;

    const result = await tx.report.updateMany({
      where: {
        id: { in: toLock },
        deletedAt: null,
        campaignId: null,
        status: ReportStatus._STATUS_TODO,
      },
      data: { campaignId, status: ReportStatus._STATUS_INPROCESS, updatedBy: userId },
    });
    if (result.count !== toLock.length) {
      const nowLocked = await tx.report.findMany({
        where: { id: { in: toLock }, campaignId },
        select: { id: true },
      });
      const got = new Set(nowLocked.map((r) => r.id));
      const taken = toLock.filter((id) => !got.has(id));
      throw new HttpError(HTTP_STATUS.CAMPAIGN_REPORTS_TAKEN, { reportIds: taken });
    }
  }

  /** Releases every report the campaign holds (block, expire, delete). */
  async releaseAllReports(tx: Tx, campaignId: string, userId: string | null): Promise<void> {
    await tx.report.updateMany({
      where: { campaignId, deletedAt: null, status: ReportStatus._STATUS_INPROCESS },
      data: {
        campaignId: null,
        status: ReportStatus._STATUS_TODO,
        ...(userId ? { updatedBy: userId } : {}),
      },
    });
    await tx.report.updateMany({
      where: { campaignId, deletedAt: null },
      data: { campaignId: null, ...(userId ? { updatedBy: userId } : {}) },
    });
  }

  // ---------------------------------------------------------------------------
  // Submit (spec 1.5)
  // ---------------------------------------------------------------------------

  async submit(id: string, userId: string): Promise<CampaignWithReports> {
    const existing = await prisma.campaign.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, organizationId: true, createdBy: true, status: true, difficulty: true },
    });
    if (!existing) {
      throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"));
    }
    await campaignAccessService.assertCanManage(existing, userId);

    // Outside the transaction: an HTTP call to reward-service.
    const tier = await rewardServiceClient.getDifficultyByLevel(existing.difficulty);
    if (!tier) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "Invalid campaign difficulty; no matching tier in reward service",
        ),
      );
    }

    const { campaign, isResubmission } = await prisma.$transaction(
      async (tx) => {
        const campaign = await this.loadInTx(tx, id);
        const event: CampaignTransitionEvent =
          campaign.status === CampaignStatus.NEEDS_REVISION ? "resubmit" : "submit";
        const eligibility = await campaignEligibilityService.assertCanSubmit(
          tx,
          userId,
          campaign.organizationId,
          campaign.id,
        );

        const points = campaign.meetingPoints ?? [];
        const reportIds = points.flatMap((p) => p.reports.map((r) => r.reportId));
        const leaderIds = [
          ...new Set(points.map((p) => p.leaderUserId).filter((x): x is string => !!x)),
        ];
        const [reports, leaderMembers] = await Promise.all([
          tx.report.findMany({
            where: {
              id: { in: reportIds },
              deletedAt: null,
              OR: [
                { campaignId: null, status: ReportStatus._STATUS_TODO },
                { campaignId: campaign.id },
              ],
            },
            select: { id: true, latitude: true, longitude: true },
          }),
          organizationMemberRepository.findActiveMemberUserIds(
            campaign.organizationId,
            leaderIds,
          ),
        ]);

        const requirements = withDefaultRequirements(
          (campaign.requirements as CampaignRequirements | null) ?? null,
          campaign.difficulty,
        );
        const issues = validateCampaignForSubmit(
          {
            title: campaign.title,
            description: campaign.description,
            banner: campaign.banner,
            startDate: campaign.startDate,
            endDate: campaign.endDate,
            contactName: campaign.contactName,
            contactPhone: campaign.contactPhone,
            difficulty: campaign.difficulty,
            requirements,
            meetingPoints: points.map((p) => ({
              name: p.name,
              latitude: p.latitude,
              longitude: p.longitude,
              radiusKm: p.radiusKm,
              gatherAt: p.gatherAt,
              slots: p.slots,
              leaderUserId: p.leaderUserId,
              reportIds: p.reports.map((r) => r.reportId),
            })),
          },
          {
            now: new Date(),
            maxVolunteers: tier.maxVolunteers,
            maxDifficulty: eligibility.maxDifficulty,
            reports: new Map(reports.map((r) => [r.id, r])),
            eligibleLeaderIds: leaderMembers,
          },
        );
        if (issues.length > 0) {
          throw new HttpError(HTTP_STATUS.CAMPAIGN_INVALID, { details: issues });
        }

        await this.syncReportLocks(tx, campaign.id, userId);

        // The creator and every meeting point leader manage the campaign.
        const managerIds = [
          ...new Set([campaign.createdBy ?? userId, ...leaderIds]),
        ];
        for (const managerId of managerIds) {
          await tx.campaignManager.upsert({
            where: { campaignId_userId: { campaignId: campaign.id, userId: managerId } },
            create: {
              campaignId: campaign.id,
              userId: managerId,
              assignedBy: userId,
              createdBy: userId,
              updatedBy: userId,
            },
            update: { deletedAt: null, updatedBy: userId },
          });
        }

        const snapshot = toSnapshot({
          ...campaign,
          requirements: requirements as Prisma.JsonValue,
        });
        const isResubmission = event === "resubmit";
        const changes = isResubmission
          ? diffSnapshots(
              campaign.lastSubmittedSnapshot as Partial<CampaignSnapshot> | null,
              snapshot,
            )
          : undefined;

        await transitionCampaign(tx, {
          campaignId: campaign.id,
          event,
          fromStatus: campaign.status,
          actor: "manager",
          actorId: userId,
          changes: changes as Prisma.InputJsonValue | undefined,
          data: {
            submittedAt: new Date(),
            revisionDeadline: null,
            requirements: requirements as Prisma.InputJsonValue,
            lastSubmittedSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          },
        });

        return { campaign: await this.loadInTx(tx, campaign.id), isResubmission };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    void this.notifySubmitted(campaign, userId, isResubmission).catch((err) =>
      console.warn("[campaign] failed to send submit notifications", err),
    );
    return campaign;
  }

  // ---------------------------------------------------------------------------
  // Admin review (spec phase 2)
  // ---------------------------------------------------------------------------

  async review(
    id: string,
    adminUserId: string,
    decision: ReviewDecision,
    reason: string | null | undefined,
  ): Promise<CampaignWithReports> {
    const existing = await prisma.campaign.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, organizationId: true, status: true },
    });
    if (!existing) {
      throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"));
    }
    if (
      await organizationMemberRepository.isActiveMember(
        existing.organizationId,
        adminUserId,
      )
    ) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_REVIEW_CONFLICT_OF_INTEREST);
    }

    const trimmed = reason?.trim() || null;

    const campaign = await prisma.$transaction(
      async (tx) => {
        const current = await this.loadInTx(tx, id);
        const event: CampaignTransitionEvent =
          decision === "block" && current.status === CampaignStatus.ACTIVE
            ? "ban"
            : decision;
        const data: Omit<Prisma.CampaignUpdateManyMutationInput, "status"> =
          decision === "approve"
            ? { rejectReason: null, revisionDeadline: null }
            : decision === "request_revision"
              ? {
                  rejectReason: trimmed,
                  revisionDeadline: new Date(
                    Date.now() + CAMPAIGN_REVISION_HOLD_DAYS * DAY_MS,
                  ),
                }
              : { rejectReason: trimmed, revisionDeadline: null };

        await transitionCampaign(tx, {
          campaignId: id,
          event,
          fromStatus: current.status,
          actor: "admin",
          actorId: adminUserId,
          reason: trimmed,
          data,
        });
        if (decision === "block") {
          await this.releaseAllReports(tx, id, adminUserId);
        }
        return this.loadInTx(tx, id);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    void this.notifyReviewed(campaign, decision, trimmed).catch((err) =>
      console.warn("[campaign] failed to send review notifications", err),
    );
    return campaign;
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  async getHistory(
    id: string,
    userId: string,
    role: string | null | undefined,
  ): Promise<CampaignStatusLogResponse[]> {
    if (!isPlatformAdmin(role)) {
      await campaignAccessService.assertCanManage(id, userId);
    }
    const rows = await prisma.campaignStatusLog.findMany({
      where: { campaignId: id },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      event: r.event,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      actorId: r.actorId,
      actorRole: r.actorRole,
      reason: r.reason,
      changes: r.changes,
      createdAt: r.createdAt,
    }));
  }

  // ---------------------------------------------------------------------------
  // Scheduled sweeps
  // ---------------------------------------------------------------------------

  /**
   * Expires campaigns whose review never finished: under review or waiting for changes past
   * their start time, or waiting for changes past the revision deadline. Releases their reports.
   */
  async expireOverdue(now = new Date()): Promise<number> {
    const candidates = await prisma.campaign.findMany({
      where: {
        deletedAt: null,
        OR: [
          {
            status: { in: [CampaignStatus.PENDING_REVIEW, CampaignStatus.NEEDS_REVISION] },
            startDate: { lte: now },
          },
          {
            status: CampaignStatus.NEEDS_REVISION,
            revisionDeadline: { lte: now },
          },
        ],
      },
      select: { id: true, status: true, revisionDeadline: true, startDate: true },
      take: 200,
    });

    let expired = 0;
    for (const c of candidates) {
      const revisionOverdue =
        c.status === CampaignStatus.NEEDS_REVISION &&
        c.revisionDeadline != null &&
        c.revisionDeadline <= now &&
        !(c.startDate && c.startDate <= now);
      try {
        const campaign = await prisma.$transaction(async (tx) => {
          await transitionCampaign(tx, {
            campaignId: c.id,
            event: "expire",
            fromStatus: c.status,
            actor: "system",
            actorId: null,
            reason: revisionOverdue ? "revision_overdue" : "start_passed",
          });
          await this.releaseAllReports(tx, c.id, null);
          return this.loadInTx(tx, c.id);
        });
        expired += 1;
        void this.notifyExpired(campaign, revisionOverdue).catch((err) =>
          console.warn("[campaign] failed to send expiry notification", err),
        );
      } catch (error) {
        // Someone acted on it meanwhile (e.g. resubmitted); the next sweep re-evaluates.
        console.warn("[campaign] expire skipped", { campaignId: c.id, error });
      }
    }
    return expired;
  }

  /** Deletes drafts nobody touched for `CAMPAIGN_DRAFT_TTL_DAYS`. Drafts lock nothing. */
  async deleteStaleDrafts(now = new Date()): Promise<number> {
    const result = await prisma.campaign.updateMany({
      where: {
        deletedAt: null,
        status: CampaignStatus.DRAFT,
        updatedAt: { lte: new Date(now.getTime() - CAMPAIGN_DRAFT_TTL_DAYS * DAY_MS) },
      },
      data: { deletedAt: now },
    });
    return result.count;
  }

  // ---------------------------------------------------------------------------
  // Notifications (matrix in the spec)
  // ---------------------------------------------------------------------------

  private async orgName(organizationId: string): Promise<string> {
    const org = await organizationRepository.findById(organizationId).catch(() => null);
    return org?.name ?? "";
  }

  private async managerIds(campaignId: string): Promise<string[]> {
    const rows = await prisma.campaignManager.findMany({
      where: { campaignId, deletedAt: null },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  private async notifySubmitted(
    campaign: CampaignWithReports,
    submitterId: string,
    isResubmission: boolean,
  ): Promise<void> {
    const organizationName = await this.orgName(campaign.organizationId);
    const payload = {
      campaignId: campaign.id,
      organizationId: campaign.organizationId,
      organizationName,
      isResubmission: isResubmission ? "true" : "",
      ...campaignTitleNotificationPayload(campaign),
    };
    const adminIds = getCampaignAdminNotifyUserIds();
    if (adminIds.length === 0) {
      console.warn(
        "[campaign] CAMPAIGN_ADMIN_NOTIFY_USER_IDS empty; admins not told about a campaign waiting for review",
        { campaignId: campaign.id },
      );
    }
    const [owners, managers] = await Promise.all([
      organizationMemberRepository.findOwnerUserIds(campaign.organizationId),
      this.managerIds(campaign.id),
    ]);
    const orgRecipients = [...new Set([...owners, ...managers])].filter(
      (id) => id !== submitterId,
    );
    await Promise.all([
      adminIds.length > 0
        ? enqueueWebsiteNotificationsToUsers({
            kind: "CAMPAIGN_PENDING_REVIEW",
            userIds: adminIds,
            payload,
          })
        : Promise.resolve(),
      // "The organization has a new campaign": owners and managers only; plain members
      // hear about it once it is approved.
      !isResubmission && orgRecipients.length > 0
        ? enqueueWebsiteNotificationsToUsers({
            kind: "CAMPAIGN_CREATED",
            userIds: orgRecipients,
            payload,
          })
        : Promise.resolve(),
    ]);
  }

  private async notifyReviewed(
    campaign: CampaignWithReports,
    decision: ReviewDecision,
    reason: string | null,
  ): Promise<void> {
    const organizationName = await this.orgName(campaign.organizationId);
    const base = {
      campaignId: campaign.id,
      organizationId: campaign.organizationId,
      organizationName,
      ...campaignTitleNotificationPayload(campaign),
    };
    const owners = await organizationMemberRepository.findOwnerUserIds(
      campaign.organizationId,
    );

    if (decision === "approve") {
      const [managers, members] = await Promise.all([
        this.managerIds(campaign.id),
        organizationMemberRepository.findAllActiveByOrganization(campaign.organizationId),
      ]);
      const recipients = [
        ...new Set([...owners, ...managers, ...members.map((m) => m.userId)]),
      ];
      if (recipients.length > 0) {
        await enqueueWebsiteNotificationsToUsers({
          kind: "CAMPAIGN_APPROVED",
          userIds: recipients,
          payload: base,
        });
      }
      return;
    }

    const recipients = [
      ...new Set([...(campaign.createdBy ? [campaign.createdBy] : []), ...owners]),
    ];
    if (recipients.length === 0) return;
    await enqueueWebsiteNotificationsToUsers({
      kind:
        decision === "request_revision"
          ? "CAMPAIGN_REVISION_REQUESTED"
          : "CAMPAIGN_BLOCKED",
      userIds: recipients,
      payload: {
        ...base,
        reason: reason ?? "",
        revisionDeadline: campaign.revisionDeadline
          ? campaign.revisionDeadline.toISOString().slice(0, 10)
          : "",
      },
    });
  }

  private async notifyExpired(
    campaign: CampaignWithReports,
    revisionOverdue: boolean,
  ): Promise<void> {
    if (!campaign.createdBy) return;
    await enqueueWebsiteNotificationsToUsers({
      kind: "CAMPAIGN_EXPIRED",
      userIds: [campaign.createdBy],
      payload: {
        campaignId: campaign.id,
        revisionOverdue: revisionOverdue ? "true" : "",
        ...campaignTitleNotificationPayload(campaign),
      },
    });
  }
}

/** True while the campaign's content may be edited freely (before approval). */
export function isPreApproval(status: number): boolean {
  return CAMPAIGN_PRE_APPROVAL_STATUSES.includes(status);
}

export const campaignLifecycleService = new CampaignLifecycleService();
