import { Prisma } from "@prisma/client";
import {
  CAMPAIGN_COMPLETION_MAX_REJECTIONS,
  CAMPAIGN_COMPLETION_REPORT_STATUS,
  CAMPAIGN_COMPLETION_UNHANDLED_REASON_MAX,
  CAMPAIGN_DIFFICULTY_MAX,
  CAMPAIGN_DIFFICULTY_MIN,
  CampaignStatus,
  SHIFT_RESULT_REPORT_STATUS,
  type CampaignAwaitingAdminReasonValue,
  type CampaignCompletionReportStatusValue,
} from "@da2/constants";
import prisma from "../../../config/prisma.client";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";
import { organizationMemberRepository } from "../../organization/organization_member.repository";
import { campaignAccessService, isPlatformAdmin } from "../campaign-access.service";
import { campaignTitleNotificationPayload, campaignNameNotificationPayload } from "../campaign-i18n";
import { campaignLifecycleService } from "../campaign-lifecycle.service";
import { transitionCampaign } from "../campaign-state-machine";
import { CAMPAIGN_INCLUDE, type CampaignWithReports } from "../campaign.entity";
import { layer1ForPoints, type PointLayer1View } from "../campaign_shift_result/result-photo.service";
import { shiftResultService, type ShiftOverview } from "../campaign_shift_result/shift-result.service";
import { hasLiveResult } from "../campaign_shift_result/shift-status";
import {
  completeCampaign,
  prepareCompletionPayout,
} from "../campaign_verification/verification-decision.service";
import {
  awaitingAdminReason,
  campaignVerificationService,
  type MeetingPointView,
} from "../campaign_verification/verification.service";
import { enqueueWebsiteNotificationsToUsers } from "../notification-jobs.client";

type Tx = Prisma.TransactionClient;

/**
 * The admin's decisions once result verification decides the campaign: cancel at any time while it
 * waits for completion; approve only when verification handed it to the admin.
 */
export type CompletionDecision = "approve" | "cancel";

export interface CompletionReportRow {
  reportId: string;
  status: CampaignCompletionReportStatusValue;
  reason: string | null;
  beforeUrls: string[];
  afterUrls: string[];
}

export interface CompletionReviewReport extends CompletionReportRow {
  meetingPointId: string | null;
  /** Layer 1 of result verification from the photos (cleaned and partial reports). */
  layer1: PointLayer1View | null;
  report: {
    title: string | null;
    detailAddress: string | null;
    latitude: number | null;
    longitude: number | null;
    severityLevel: number | null;
    wasteType: string | null;
  } | null;
}

export interface CompletionReviewShift {
  shiftId: string;
  meetingPointId: string;
  meetingPointName: string;
  startAt: Date;
  endAt: Date;
  hasResult: boolean;
  reopenedAt: Date | null;
  reopenReason: string | null;
}

/** GET /campaigns/:id/completion-review: what the admin decides on (managers see it too). */
export interface CompletionReviewView {
  campaignId: string;
  status: number;
  difficulty: number;
  difficultyRange: { min: number; max: number };
  rejectReason: string | null;
  completionSubmittedAt: Date | null;
  rejectionCount: number;
  maxRejections: number;
  /** Result verification handed the campaign to the admin: approve (complete) or cancel. */
  awaitingAdmin: boolean;
  awaitingAdminReason: CampaignAwaitingAdminReasonValue | null;
  /** Approve is possible now (only while `awaitingAdmin`). */
  canApprove: boolean;
  /** Saved snapshot once marked done; before that, a preview built from the shifts' results. */
  submission: {
    preview: boolean;
    reports: CompletionReviewReport[];
    counts: { cleaned: number; partial: number; unhandled: number };
  };
  totals: ShiftOverview["totals"];
  shifts: CompletionReviewShift[];
  /**
   * Each meeting point under result verification (latest round) with its trash points, every vote
   * (and the trash points it names) and its weight.
   */
  verification: {
    meetingPoints: MeetingPointView[];
  };
}

const REASON_MAX = CAMPAIGN_COMPLETION_UNHANDLED_REASON_MAX;

const pointName = (p: { name: string | null; sortOrder: number }) => p.name || `#${p.sortOrder + 1}`;

function assertDifficultyInRange(level: number): void {
  if (!Number.isInteger(level) || level < CAMPAIGN_DIFFICULTY_MIN || level > CAMPAIGN_DIFFICULTY_MAX) {
    throw new HttpError(
      HTTP_STATUS.VALIDATION_ERROR.withMessage(
        `difficulty must be between ${CAMPAIGN_DIFFICULTY_MIN} and ${CAMPAIGN_DIFFICULTY_MAX}`,
      ),
    );
  }
}

/**
 * Spec 5.1 / 5.2: the completion submission (built from the shifts' results) and what the admin
 * still decides once result verification replaced the manual review: cancel at any time, approve
 * (with the final difficulty) only when verification hands the campaign over (rejected 3 times, or
 * no trash point declared cleaned). Flagged meeting points are decided one by one (`campaign_verification`).
 */
export class CampaignCompletionService {
  /** The campaign's trash reports: those linked to its meeting points (as in the shift overview). */
  private async campaignReportLinks(db: Tx | typeof prisma, campaignId: string) {
    return db.campaignMeetingPointReport.findMany({
      where: { campaignId, meetingPoint: { deletedAt: null } },
      select: { reportId: true, meetingPointId: true },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Each trash report at its best state across the shifts' results (cleaned > partial), with every
   * photo; `missingIds` are the reports no result lists.
   */
  async buildSubmission(
    campaignId: string,
    db: Tx | typeof prisma = prisma,
  ): Promise<{ handled: CompletionReportRow[]; missingIds: string[] }> {
    const [links, results] = await Promise.all([
      this.campaignReportLinks(db, campaignId),
      db.campaignShiftResult.findMany({
        where: { campaignId },
        select: { reports: true },
        orderBy: { submittedAt: "asc" },
      }),
    ]);
    const merged = new Map<string, CompletionReportRow>();
    for (const result of results) {
      for (const r of result.reports) {
        const row = merged.get(r.reportId) ?? {
          reportId: r.reportId,
          status: CAMPAIGN_COMPLETION_REPORT_STATUS.PARTIAL,
          reason: null,
          beforeUrls: [],
          afterUrls: [],
        };
        if (r.status === SHIFT_RESULT_REPORT_STATUS.CLEANED) row.status = CAMPAIGN_COMPLETION_REPORT_STATUS.CLEANED;
        row.beforeUrls = [...new Set([...row.beforeUrls, ...r.beforeUrls])];
        row.afterUrls = [...new Set([...row.afterUrls, ...r.afterUrls])];
        merged.set(r.reportId, row);
      }
    }
    const reportIds = [...new Set(links.map((l) => l.reportId))];
    return {
      handled: reportIds.filter((id) => merged.has(id)).map((id) => merged.get(id)!),
      missingIds: reportIds.filter((id) => !merged.has(id)),
    };
  }

  /**
   * Spec 5.1: the submission rows; every report no shift handled needs a reason (1–500), else 422
   * `CAMPAIGN_REPORTS_UNHANDLED {reportIds}`. Reasons for other reports are ignored.
   */
  async prepareSubmission(
    campaignId: string,
    unhandled: Array<{ reportId: string; reason: string }> | undefined,
    db: Tx | typeof prisma = prisma,
  ): Promise<CompletionReportRow[]> {
    const { handled, missingIds } = await this.buildSubmission(campaignId, db);
    const reasons = new Map<string, string>();
    for (const u of unhandled ?? []) {
      const reason = typeof u?.reason === "string" ? u.reason.trim() : "";
      if (u?.reportId && reason.length > 0 && reason.length <= REASON_MAX) reasons.set(u.reportId, reason);
    }
    const lacking = missingIds.filter((id) => !reasons.has(id));
    if (lacking.length > 0) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_REPORTS_UNHANDLED, { reportIds: lacking });
    }
    return [
      ...handled,
      ...missingIds.map((reportId) => ({
        reportId,
        status: CAMPAIGN_COMPLETION_REPORT_STATUS.UNHANDLED,
        reason: reasons.get(reportId)!,
        beforeUrls: [],
        afterUrls: [],
      })),
    ];
  }

  /** Replaces the campaign's snapshot (each marking done overwrites the previous one). */
  async saveSubmission(tx: Tx, campaignId: string, rows: CompletionReportRow[], now: Date): Promise<void> {
    await tx.campaignCompletionReport.deleteMany({ where: { campaignId } });
    if (rows.length > 0) {
      await tx.campaignCompletionReport.createMany({
        data: rows.map((r) => ({ campaignId, ...r, submittedAt: now })),
      });
    }
  }

  /** Where residents are invited to verify: every meeting point, else the campaign's own point. */
  async verifyPoints(campaign: {
    id: string;
    latitude: number | null;
    longitude: number | null;
  }): Promise<Array<{ latitude: number; longitude: number }>> {
    const points = await prisma.campaignMeetingPoint.findMany({
      where: { campaignId: campaign.id, deletedAt: null },
      select: { latitude: true, longitude: true },
      orderBy: { sortOrder: "asc" },
    });
    if (points.length > 0) return points;
    return campaign.latitude != null && campaign.longitude != null
      ? [{ latitude: campaign.latitude, longitude: campaign.longitude }]
      : [];
  }

  // ---------------------------------------------------------------------------
  // Review view
  // ---------------------------------------------------------------------------

  async getForReview(
    campaignId: string,
    viewer: { userId: string; role?: string | null },
    now = new Date(),
  ): Promise<CompletionReviewView> {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, deletedAt: null },
      include: CAMPAIGN_INCLUDE,
    });
    if (!campaign) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"));
    if (!isPlatformAdmin(viewer.role)) {
      await campaignAccessService.assertCanManage(campaignId, viewer.userId);
    }

    const [overview, saved, links, shifts, meetingPoints] = await Promise.all([
      shiftResultService.overview(campaignId, { userId: viewer.userId, role: "admin" }, now),
      prisma.campaignCompletionReport.findMany({ where: { campaignId } }),
      this.campaignReportLinks(prisma, campaignId),
      prisma.campaignShift.findMany({
        where: { campaignId, minVolunteers: { gt: 0 } },
        include: {
          meetingPoint: { select: { name: true, sortOrder: true } },
          result: { select: { id: true, reopenedAt: true, reopenReason: true } },
        },
        orderBy: [{ startAt: "asc" }],
      }),
      campaignVerificationService.pointsForReview(campaign, viewer, now),
    ]);

    // Under review (or decided): the saved snapshot. Before marking done: a live preview.
    const useSaved = saved.length > 0 && campaign.status !== CampaignStatus.ACTIVE;
    let rows: CompletionReportRow[];
    if (useSaved) {
      rows = saved.map((r) => ({
        reportId: r.reportId,
        status: r.status as CampaignCompletionReportStatusValue,
        reason: r.reason,
        beforeUrls: r.beforeUrls,
        afterUrls: r.afterUrls,
      }));
    } else {
      const built = await this.buildSubmission(campaignId);
      rows = [
        ...built.handled,
        ...built.missingIds.map((reportId) => ({
          reportId,
          status: CAMPAIGN_COMPLETION_REPORT_STATUS.UNHANDLED,
          reason: null,
          beforeUrls: [],
          afterUrls: [],
        })),
      ];
    }
    const pointOf = new Map(links.map((l) => [l.reportId, l.meetingPointId]));
    const order = new Map(links.map((l, i) => [l.reportId, i]));
    rows.sort((a, b) => (order.get(a.reportId) ?? 1e9) - (order.get(b.reportId) ?? 1e9));
    const reports = await prisma.report.findMany({
      where: { id: { in: rows.map((r) => r.reportId) } },
      select: {
        id: true,
        title: true,
        detailAddress: true,
        latitude: true,
        longitude: true,
        severityLevel: true,
        wasteType: true,
      },
    });
    const reportById = new Map(reports.map((r) => [r.id, r]));
    const count = (status: string) => rows.filter((r) => r.status === status).length;
    const layer1 = await layer1ForPoints(
      campaignId,
      rows.filter((r) => r.status !== CAMPAIGN_COMPLETION_REPORT_STATUS.UNHANDLED),
    );

    return {
      campaignId,
      status: campaign.status,
      difficulty: campaign.difficulty,
      difficultyRange: { min: CAMPAIGN_DIFFICULTY_MIN, max: CAMPAIGN_DIFFICULTY_MAX },
      rejectReason: campaign.rejectReason ?? null,
      completionSubmittedAt: campaign.completionSubmittedAt ?? null,
      rejectionCount: campaign.completionRejectionCount,
      maxRejections: CAMPAIGN_COMPLETION_MAX_REJECTIONS,
      awaitingAdmin: campaign.completionAwaitingAdmin,
      awaitingAdminReason: awaitingAdminReason(campaign),
      canApprove: campaign.status === CampaignStatus.PENDING_COMPLETION && campaign.completionAwaitingAdmin,
      submission: {
        preview: !useSaved,
        reports: rows.map((r) => {
          const report = reportById.get(r.reportId);
          return {
            ...r,
            meetingPointId: pointOf.get(r.reportId) ?? null,
            layer1: layer1.get(r.reportId) ?? null,
            report: report
              ? {
                  title: report.title,
                  detailAddress: report.detailAddress,
                  latitude: report.latitude,
                  longitude: report.longitude,
                  severityLevel: report.severityLevel,
                  wasteType: report.wasteType,
                }
              : null,
          };
        }),
        counts: {
          cleaned: count(CAMPAIGN_COMPLETION_REPORT_STATUS.CLEANED),
          partial: count(CAMPAIGN_COMPLETION_REPORT_STATUS.PARTIAL),
          unhandled: count(CAMPAIGN_COMPLETION_REPORT_STATUS.UNHANDLED),
        },
      },
      totals: overview.totals,
      shifts: shifts.map((s) => ({
        shiftId: s.id,
        meetingPointId: s.meetingPointId,
        meetingPointName: pointName(s.meetingPoint),
        startAt: s.startAt,
        endAt: s.endAt,
        hasResult: hasLiveResult(s.result),
        reopenedAt: s.result?.reopenedAt ?? null,
        reopenReason: s.result?.reopenedAt ? (s.result.reopenReason ?? null) : null,
      })),
      verification: { meetingPoints },
    };
  }

  // ---------------------------------------------------------------------------
  // Admin decision (spec 5.2)
  // ---------------------------------------------------------------------------

  async review(
    campaignId: string,
    adminUserId: string,
    input: { decision: CompletionDecision; reason?: string | null; difficulty?: number | null },
  ): Promise<void> {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, deletedAt: null },
      include: CAMPAIGN_INCLUDE,
    });
    if (!campaign) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"));
    // Approving twice is harmless (a retried request).
    if (input.decision === "approve" && campaign.status === CampaignStatus.COMPLETED) return;
    if (campaign.status !== CampaignStatus.PENDING_COMPLETION) {
      throw new HttpError(
        HTTP_STATUS.CAMPAIGN_INVALID_TRANSITION.withMessage(
          "Only a campaign waiting for completion approval can be reviewed",
        ),
      );
    }
    if (input.decision === "approve") {
      if (!campaign.completionAwaitingAdmin) throw new HttpError(HTTP_STATUS.CAMPAIGN_COMPLETION_NOT_AWAITING_ADMIN);
      return this.approve(campaign, adminUserId, input.difficulty ?? null);
    }
    if (input.decision !== "cancel") {
      throw new HttpError(
        HTTP_STATUS.VALIDATION_ERROR.withMessage("decision is approve or cancel; meeting points are rejected one by one"),
      );
    }
    const reason = input.reason?.trim() ?? "";
    if (!reason) {
      throw new HttpError(HTTP_STATUS.VALIDATION_ERROR.withMessage("A reason is required"));
    }
    return this.cancel(campaign, adminUserId, reason);
  }

  /**
   * Approve (handed over by result verification): the difficulty may be settled one last time
   * (logged) and points follow it; trash points declared cleaned are completed, the rest go back
   * to the waiting list; SOS closed; points emitted.
   */
  private async approve(
    campaign: CampaignWithReports,
    adminUserId: string,
    difficulty: number | null,
  ): Promise<void> {
    const finalDifficulty = difficulty ?? campaign.difficulty;
    assertDifficultyInRange(finalDifficulty);
    const payout = await prepareCompletionPayout(campaign.id, finalDifficulty);
    await prisma.$transaction(
      (tx) => completeCampaign(tx, campaign, { actor: "admin", actorId: adminUserId, payout }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    void this.notifyApproved(campaign, payout.volunteerIds).catch((err) =>
      console.warn("[campaign] failed to notify completion approval", err),
    );
  }

  /** Cancel: no points; reports back to the waiting list; volunteers and team hear (outbox). */
  private async cancel(campaign: CampaignWithReports, adminUserId: string, reason: string): Promise<void> {
    await prisma.$transaction(
      async (tx) => {
        await transitionCampaign(tx, {
          campaignId: campaign.id,
          event: "cancel_by_admin",
          fromStatus: campaign.status,
          actor: "admin",
          actorId: adminUserId,
          reason,
          data: { rejectReason: reason },
        });
        await campaignLifecycleService.releaseAllReports(tx, campaign.id, adminUserId);
        await campaignLifecycleService.emitCancelledNotices(tx, campaign, {
          reason,
          actorId: adminUserId,
          by: "admin",
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async notifyApproved(campaign: CampaignWithReports, volunteerIds: string[]): Promise<void> {
    if (volunteerIds.length > 0) {
      await enqueueWebsiteNotificationsToUsers({
        kind: "CAMPAIGN_DONE",
        userIds: volunteerIds,
        payload: { campaignId: campaign.id, ...campaignNameNotificationPayload(campaign) },
      });
    }
    const owners = await organizationMemberRepository.findOwnerUserIds(campaign.organizationId);
    if (owners.length > 0) {
      await enqueueWebsiteNotificationsToUsers({
        kind: "CAMPAIGN_COMPLETION_APPROVED_BY_ADMIN",
        userIds: owners,
        payload: { campaignId: campaign.id, ...campaignTitleNotificationPayload(campaign) },
      });
    }
  }
}

export const campaignCompletionService = new CampaignCompletionService();
