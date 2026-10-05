import { Prisma } from "@prisma/client";
import {
  CAMPAIGN_COMPLETION_REPORT_STATUS,
  CampaignStatus,
  MEETING_POINT_STATUS,
} from "@da2/constants";
import prisma from "../../../config/prisma.client";
import { HttpError } from "../../../constants/http-status";
import { GlobalStatus, ReportStatus } from "../../../constants/status.enum";
import { emitOutbox } from "../../../outbox/outbox.writer";
import { OutboxEventType } from "../../../outbox/outbox.types";
import { organizationMemberRepository } from "../../organization/organization_member.repository";
import { rewardServiceClient } from "../../reward/reward-service.client";
import { getCampaignAdminNotifyUserIds } from "../campaign-completion-admin-notify.config";
import { campaignNameNotificationPayload, campaignTitleNotificationPayload } from "../campaign-i18n";
import { transitionCampaign, type CampaignActorRole } from "../campaign-state-machine";
import { CAMPAIGN_INCLUDE, type CampaignWithReports } from "../campaign.entity";
import { shiftAttendanceService } from "../campaign_attendance/shift-attendance.service";
import { campaignRegistrationRepository } from "../campaign_registration/campaign_registration.repository";
import { localDayMonth, localHourMinute } from "../campaign_registration/staffing-shared";
import { campaignDecision, type CampaignDecision } from "./verification-rules";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export type MeetingPointVerificationRow = Prisma.MeetingPointVerificationGetPayload<object>;

const pointName = (p: { name: string | null; sortOrder: number }) => p.name || `#${p.sortOrder + 1}`;
const shiftLabel = (s: { startAt: Date; meetingPoint: { name: string | null; sortOrder: number } }) =>
  `${pointName(s.meetingPoint)} ${localDayMonth(s.startAt)} ${localHourMinute(s.startAt)}`;

/** A website notification through the outbox, inside the deciding transaction. */
export async function emitWebsiteNotice(
  tx: Tx,
  args: { campaignId: string; kind: string; userIds: string[]; payload: Record<string, string>; dedupKey: string },
): Promise<void> {
  const userIds = [...new Set(args.userIds)];
  if (userIds.length === 0) return;
  await emitOutbox(tx, {
    aggregateType: "campaign",
    aggregateId: args.campaignId,
    eventType: OutboxEventType.WEBSITE_NOTIFICATION,
    dedupKey: args.dedupKey,
    payload: { kind: args.kind, userIds, payload: args.payload },
  });
}

/** Owners of the organization, the creator and the campaign's managers. */
export async function campaignTeamIds(
  campaign: Pick<CampaignWithReports, "organizationId" | "createdBy" | "campaignManagers">,
): Promise<string[]> {
  const owners = await organizationMemberRepository.findOwnerUserIds(campaign.organizationId);
  return [
    ...new Set([
      ...owners,
      ...(campaign.createdBy ? [campaign.createdBy] : []),
      ...campaign.campaignManagers.map((m) => m.userId),
    ]),
  ];
}

/**
 * The latest round of each meeting point holding a trash point declared cleaned in the campaign's
 * current submission (a meeting point verified in an earlier round keeps that round).
 */
export async function latestRounds(db: Db, campaignId: string): Promise<MeetingPointVerificationRow[]> {
  const cleaned = await db.campaignCompletionReport.findMany({
    where: { campaignId, status: CAMPAIGN_COMPLETION_REPORT_STATUS.CLEANED },
    select: { reportId: true },
  });
  if (cleaned.length === 0) return [];
  const links = await db.campaignMeetingPointReport.findMany({
    where: { campaignId, reportId: { in: cleaned.map((c) => c.reportId) } },
    select: { meetingPointId: true },
  });
  const meetingPointIds = [...new Set(links.map((l) => l.meetingPointId))];
  if (meetingPointIds.length === 0) return [];
  const rows = await db.meetingPointVerification.findMany({
    where: { campaignId, meetingPointId: { in: meetingPointIds } },
    orderBy: [{ meetingPointId: "asc" }, { round: "desc" }],
  });
  const latest = new Map<string, MeetingPointVerificationRow>();
  for (const r of rows) if (!latest.has(r.meetingPointId)) latest.set(r.meetingPointId, r);
  return [...latest.values()];
}

/** What completing pays out, read before the transaction (reward-service is remote). */
export interface CompletionPayout {
  difficulty: number;
  credits: Array<{ userId: string; points: number }>;
  /** Everyone registered or present hears the campaign is done (spec 5.4). */
  volunteerIds: string[];
}

export async function prepareCompletionPayout(campaignId: string, difficulty: number): Promise<CompletionPayout> {
  const tier = await rewardServiceClient.getDifficultyByLevel(difficulty);
  if (!tier) throw new Error("Campaign difficulty missing in reward service");
  /** Green points per shift attended long enough (spec 4.1, 5.3), at the settled difficulty. */
  const credits = await shiftAttendanceService.completionCredits(campaignId, tier.greenPoints);
  const volunteerIds = [
    ...new Set([
      ...(await campaignRegistrationRepository.findRegisteredUserIds(campaignId)),
      ...credits.map((c) => c.userId),
    ]),
  ];
  return { difficulty, credits, volunteerIds };
}

/**
 * Completes a campaign waiting for completion, by result verification (system) or the admin:
 * trash points declared cleaned are done; partly done, unhandled and anything else the campaign
 * held go back to the waiting list; SOS closed; green points emitted. Runs inside `tx`.
 */
export async function completeCampaign(
  tx: Tx,
  campaign: CampaignWithReports,
  args: { actor: Extract<CampaignActorRole, "admin" | "system">; actorId: string | null; payout: CompletionPayout },
): Promise<void> {
  const id = campaign.id;
  const { difficulty, credits } = args.payout;
  const difficultyChanged = difficulty !== campaign.difficulty;
  await transitionCampaign(tx, {
    campaignId: id,
    event: "approve_completion",
    fromStatus: campaign.status,
    actor: args.actor,
    actorId: args.actorId,
    data: { rejectReason: null, difficulty, completionAwaitingAdmin: false },
    ...(difficultyChanged ? { changes: { difficulty: { from: campaign.difficulty, to: difficulty } } } : {}),
  });

  const by = args.actorId ? { updatedBy: args.actorId } : {};
  const snapshot = await tx.campaignCompletionReport.findMany({
    where: { campaignId: id },
    select: { reportId: true, status: true },
  });
  if (snapshot.length === 0) {
    // Marked done before submissions existed: every report counts as done, as before.
    await tx.report.updateMany({
      where: { campaignId: id, deletedAt: null },
      data: { status: ReportStatus._STATUS_COMPLETED, ...by },
    });
  } else {
    const cleanedIds = snapshot
      .filter((r) => r.status === CAMPAIGN_COMPLETION_REPORT_STATUS.CLEANED)
      .map((r) => r.reportId);
    await tx.report.updateMany({
      where: { campaignId: id, deletedAt: null, id: { in: cleanedIds } },
      data: { status: ReportStatus._STATUS_COMPLETED, ...by },
    });
    // Partly done, unhandled and anything else the campaign held go back to the waiting list.
    await tx.report.updateMany({
      where: { campaignId: id, deletedAt: null, id: { notIn: cleanedIds } },
      data: { campaignId: null, status: ReportStatus._STATUS_TODO, ...by },
    });
  }
  await tx.sos.updateMany({
    where: { campaignId: id, deletedAt: null, status: { not: GlobalStatus._STATUS_COMPLETED } },
    data: { status: GlobalStatus._STATUS_COMPLETED, ...by },
  });
  if (credits.length > 0) {
    await emitOutbox(tx, {
      aggregateType: "campaign",
      aggregateId: id,
      eventType: OutboxEventType.CAMPAIGN_COMPLETION_GREEN_POINTS,
      payload: { campaignId: id, credits },
      dedupKey: `${OutboxEventType.CAMPAIGN_COMPLETION_GREEN_POINTS}:${id}`,
    });
  }
}

/**
 * Hands the campaign to the admin (complete or cancel): rejected 3 times already, or nothing
 * declared cleaned. Admins hear once per submission. Runs inside `tx`; false if already handed.
 */
export async function markAwaitingAdmin(
  tx: Tx,
  campaign: Pick<CampaignWithReports, "id" | "status" | "title" | "titleVi" | "titleEn">,
  args: { reason: string; submittedAt: Date | null },
): Promise<boolean> {
  const updated = await tx.campaign.updateMany({
    where: { id: campaign.id, status: CampaignStatus.PENDING_COMPLETION, completionAwaitingAdmin: false },
    data: { completionAwaitingAdmin: true },
  });
  if (updated.count === 0) return false;
  await tx.campaignStatusLog.create({
    data: {
      campaignId: campaign.id,
      type: "EDIT",
      event: "completion_awaiting_admin",
      fromStatus: campaign.status,
      toStatus: campaign.status,
      actorId: null,
      actorRole: "system",
      changes: { reason: args.reason },
    },
  });
  const adminIds = getCampaignAdminNotifyUserIds();
  if (adminIds.length === 0) {
    console.warn("[campaign] CAMPAIGN_ADMIN_NOTIFY_USER_IDS empty; no admin hears of a completion to decide", {
      campaignId: campaign.id,
    });
  }
  await emitWebsiteNotice(tx, {
    campaignId: campaign.id,
    kind: "CAMPAIGN_COMPLETION_PENDING_ADMIN",
    userIds: adminIds,
    payload: { campaignId: campaign.id, reason: args.reason, ...campaignTitleNotificationPayload(campaign) },
    dedupKey: `CAMPAIGN_COMPLETION_PENDING_ADMIN:${campaign.id}:${(args.submittedAt ?? new Date(0)).toISOString()}`,
  });
  return true;
}

/** Report titles for reasons and notifications ("#n" in the campaign's order when untitled). */
export async function reportTitles(campaignId: string, reportIds: string[]): Promise<Map<string, string>> {
  if (reportIds.length === 0) return new Map();
  const [reports, links] = await Promise.all([
    prisma.report.findMany({ where: { id: { in: reportIds } }, select: { id: true, title: true, titleVi: true } }),
    prisma.campaignMeetingPointReport.findMany({
      where: { campaignId },
      select: { reportId: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const order = new Map(links.map((l, i) => [l.reportId, i]));
  return new Map(
    reportIds.map((id) => {
      const r = reports.find((x) => x.id === id);
      return [id, r?.titleVi || r?.title || `#${(order.get(id) ?? 0) + 1}`];
    }),
  );
}

/** A meeting point's name for reasons and notifications ("#n" in the campaign's order when unnamed). */
export async function meetingPointNameOf(meetingPointId: string): Promise<string> {
  const p = await prisma.campaignMeetingPoint.findUnique({
    where: { id: meetingPointId },
    select: { name: true, sortOrder: true },
  });
  return p ? pointName(p) : "";
}

/**
 * Result verification, the campaign's decision from its meeting points (spec "Quyết định cho chiến
 * dịch"): every meeting point verified, COMPLETED; one rejected and none left to decide, REJECTED
 * back to running with the shifts that submitted photos for a trash point that did not pass
 * reopened, or after 3 rejections handed to the admin; otherwise nothing. Safe to call any time and
 * concurrently: transitions compare-and-set.
 */
export class VerificationDecisionService {
  async decideCampaign(campaignId: string, now = new Date()): Promise<CampaignDecision> {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, deletedAt: null },
      include: CAMPAIGN_INCLUDE,
    });
    if (!campaign || campaign.status !== CampaignStatus.PENDING_COMPLETION || campaign.completionAwaitingAdmin) {
      return "wait";
    }
    const rounds = await latestRounds(prisma, campaignId);
    const decision = campaignDecision(
      rounds.map((r) => r.status),
      campaign.completionRejectionCount,
    );
    try {
      if (decision === "complete") await this.complete(campaign);
      else if (decision === "reject") await this.reject(campaign, rounds, now);
      else if (decision === "await_admin") {
        await prisma.$transaction((tx) =>
          markAwaitingAdmin(tx, campaign, {
            reason: "rejection_limit",
            submittedAt: campaign.completionSubmittedAt,
          }),
        );
      }
    } catch (error) {
      // Another vote or the sweep decided it meanwhile.
      if (HttpError.isHttpError(error) && error.statusResponse.code === "CAMPAIGN_INVALID_TRANSITION") return "wait";
      throw error;
    }
    return decision;
  }

  private async complete(campaign: CampaignWithReports): Promise<void> {
    const payout = await prepareCompletionPayout(campaign.id, campaign.difficulty);
    const teamIds = await campaignTeamIds(campaign);
    await prisma.$transaction(
      async (tx) => {
        await completeCampaign(tx, campaign, { actor: "system", actorId: null, payout });
        await emitWebsiteNotice(tx, {
          campaignId: campaign.id,
          kind: "CAMPAIGN_DONE",
          userIds: payout.volunteerIds,
          payload: { campaignId: campaign.id, ...campaignNameNotificationPayload(campaign) },
          dedupKey: `CAMPAIGN_DONE:${campaign.id}`,
        });
        await emitWebsiteNotice(tx, {
          campaignId: campaign.id,
          kind: "CAMPAIGN_RESULT_VERIFIED",
          userIds: teamIds,
          payload: { campaignId: campaign.id, ...campaignTitleNotificationPayload(campaign) },
          dedupKey: `CAMPAIGN_RESULT_VERIFIED:${campaign.id}`,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * REJECTED: back to running; the shifts that submitted photos for a trash point that did not pass
   * (`failedReportIds` of each rejected meeting point) reopen with the reasons that concern them.
   */
  private async reject(campaign: CampaignWithReports, rounds: MeetingPointVerificationRow[], now: Date) {
    const rejected = rounds.filter((r) => r.status === MEETING_POINT_STATUS.REJECTED);
    const failedOf = (r: MeetingPointVerificationRow) => (r.failedReportIds.length > 0 ? r.failedReportIds : r.reportIds);
    const failedIds = [...new Set(rejected.flatMap(failedOf))];
    const [titles, points] = await Promise.all([
      reportTitles(campaign.id, failedIds),
      prisma.campaignMeetingPoint.findMany({
        where: { id: { in: rejected.map((r) => r.meetingPointId) } },
        select: { id: true, name: true, sortOrder: true },
      }),
    ]);
    const nameOf = new Map(points.map((p) => [p.id, pointName(p)]));
    const reasonOf = (r: MeetingPointVerificationRow, only?: Set<string>) => {
      const ids = failedOf(r).filter((id) => !only || only.has(id));
      return `${nameOf.get(r.meetingPointId) ?? ""} (${ids.map((id) => titles.get(id)).join(", ")}): ${r.decisionReason ?? "Rejected"}`;
    };
    const shifts = await prisma.campaignShift.findMany({
      where: {
        campaignId: campaign.id,
        result: { reports: { some: { reportId: { in: failedIds } } } },
      },
      select: {
        id: true,
        startAt: true,
        meetingPoint: { select: { name: true, sortOrder: true } },
        result: { select: { reports: { select: { reportId: true } } } },
      },
      orderBy: { startAt: "asc" },
    });
    const reason = rejected.map((r) => reasonOf(r)).join("; ");
    const teamIds = await campaignTeamIds(campaign);
    await prisma.$transaction(async (tx) => {
      await transitionCampaign(tx, {
        campaignId: campaign.id,
        event: "reject_completion",
        fromStatus: campaign.status,
        actor: "system",
        actorId: null,
        reason,
        changes: {
          shiftIds: shifts.map((s) => s.id),
          meetingPointIds: rejected.map((r) => r.meetingPointId),
          reportIds: failedIds,
        },
        data: { rejectReason: reason, completionRejectionCount: { increment: 1 } },
      });
      for (const s of shifts) {
        const own = new Set(s.result?.reports.map((r) => r.reportId));
        await tx.campaignShiftResult.updateMany({
          where: { shiftId: s.id },
          data: {
            reopenedAt: now,
            reopenReason: rejected
              .filter((r) => failedOf(r).some((id) => own.has(id)))
              .map((r) => reasonOf(r, own))
              .join("; "),
            reopenedBy: null,
          },
        });
      }
      await emitWebsiteNotice(tx, {
        campaignId: campaign.id,
        kind: "CAMPAIGN_RESULT_REJECTED",
        userIds: teamIds,
        payload: {
          campaignId: campaign.id,
          reasons: reason,
          shifts: shifts.map(shiftLabel).join(", "),
          ...campaignTitleNotificationPayload(campaign),
        },
        dedupKey: `CAMPAIGN_RESULT_REJECTED:${campaign.id}:${campaign.completionRejectionCount + 1}`,
      });
    });
  }
}

export const verificationDecisionService = new VerificationDecisionService();
