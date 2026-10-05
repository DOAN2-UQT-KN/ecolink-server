import {
  CampaignStatus,
  MEETING_POINT_DECISION,
  MEETING_POINT_REPORTER_REMIND_HOURS,
  MEETING_POINT_STATUS,
  type ResultCheckLevelValue,
} from "@da2/constants";
import prisma from "../../../config/prisma.client";
import { campaignTitleNotificationPayload } from "../campaign-i18n";
import { CAMPAIGN_INCLUDE } from "../campaign.entity";
import {
  emitWebsiteNotice,
  meetingPointNameOf,
  reportTitles,
  verificationDecisionService,
} from "./verification-decision.service";
import { pointAtWindowEnd, SYSTEM_REJECT_REASON, tally } from "./verification-rules";
import { campaignVerificationService } from "./verification.service";

const HOUR_MS = 60 * 60 * 1000;
const BATCH = 200;

export interface VerificationSweepResult {
  /** Windows closed: meeting points verified, flagged or rejected. */
  closed: number;
  /** Flagged meeting points the admin did not decide in time, rejected. */
  expiredFlags: number;
  /** Original reporters reminded. */
  reminded: number;
  /** Campaigns that were decided (completed, rejected or handed to the admin). */
  decided: number;
}

/**
 * Result verification sweep (with the campaign lifecycle job), per meeting point: closes voting
 * windows (a downvote flags it; without one, Layer 1 decides), rejects flagged ones the admin left
 * for 48 h, reminds the original reporters who have not voted once after 24 h, then decides each
 * campaign touched. Every step is compare-and-set, so a run racing a vote changes nothing twice.
 */
export async function runResultVerificationSweep(now = new Date()): Promise<VerificationSweepResult> {
  const result: VerificationSweepResult = { closed: 0, expiredFlags: 0, reminded: 0, decided: 0 };
  const touched = new Set<string>();
  const pending = { campaign: { deletedAt: null, status: CampaignStatus.PENDING_COMPLETION } };

  const loadCampaign = (id: string) =>
    prisma.campaign.findFirstOrThrow({ where: { id }, include: CAMPAIGN_INCLUDE });

  // 1. Windows that closed on meeting points still voting.
  const closing = await prisma.meetingPointVerification.findMany({
    where: { status: MEETING_POINT_STATUS.VOTING, windowEndsAt: { lte: now }, ...pending },
    include: { votes: { select: { value: true, weight: true } } },
    take: BATCH,
  });
  for (const row of closing) {
    try {
      const campaign = await loadCampaign(row.campaignId);
      const to = pointAtWindowEnd({
        hasDownvote: tally(row.votes).hasDownvote,
        layer1Level: row.layer1Level as ResultCheckLevelValue,
      });
      const moved = await prisma.$transaction((tx) =>
        campaignVerificationService.transitionPoint(tx, row, to, {
          campaign,
          now,
          reason: to.code ? (SYSTEM_REJECT_REASON[to.code] ?? null) : null,
        }),
      );
      if (moved) {
        result.closed += 1;
        touched.add(row.campaignId);
      }
    } catch (error) {
      console.warn("[campaign] closing a verification window failed", { verificationId: row.id, error });
    }
  }

  // 2. Flagged meeting points past the admin's deadline.
  const expired = await prisma.meetingPointVerification.findMany({
    where: { status: MEETING_POINT_STATUS.FLAGGED, flagDeadline: { lte: now }, ...pending },
    take: BATCH,
  });
  for (const row of expired) {
    try {
      const campaign = await loadCampaign(row.campaignId);
      const moved = await prisma.$transaction((tx) =>
        campaignVerificationService.transitionPoint(
          tx,
          row,
          { status: MEETING_POINT_STATUS.REJECTED, code: MEETING_POINT_DECISION.FLAG_TIMEOUT },
          { campaign, now, reason: SYSTEM_REJECT_REASON[MEETING_POINT_DECISION.FLAG_TIMEOUT] },
        ),
      );
      if (moved) {
        result.expiredFlags += 1;
        touched.add(row.campaignId);
      }
    } catch (error) {
      console.warn("[campaign] rejecting an expired flag failed", { verificationId: row.id, error });
    }
  }

  // 3. The original reporters, once, 24 h into the window, those who have not voted yet.
  const remind = await prisma.meetingPointVerification.findMany({
    where: {
      status: { in: [MEETING_POINT_STATUS.VOTING, MEETING_POINT_STATUS.FLAGGED] },
      reporterIds: { isEmpty: false },
      reporterRemindedAt: null,
      windowEndsAt: { gt: now },
      createdAt: { lte: new Date(now.getTime() - MEETING_POINT_REPORTER_REMIND_HOURS * HOUR_MS) },
      ...pending,
    },
    include: { votes: { select: { userId: true } } },
    take: BATCH,
  });
  for (const row of remind) {
    const voted = new Set(row.votes.map((v) => v.userId));
    if (row.reporterIds.every((id) => voted.has(id))) continue;
    try {
      const campaign = await loadCampaign(row.campaignId);
      const blocked = await campaignVerificationService.blockedVoterIds(prisma, campaign);
      const waiting = row.reporterIds.filter((id) => !voted.has(id) && !blocked.has(id));
      const reports = await prisma.report.findMany({
        where: { id: { in: row.reportIds }, userId: { in: waiting } },
        select: { id: true, userId: true },
      });
      const titles = await reportTitles(row.campaignId, reports.map((r) => r.id));
      const meetingPointName = await meetingPointNameOf(row.meetingPointId);
      await prisma.$transaction(async (tx) => {
        const marked = await tx.meetingPointVerification.updateMany({
          where: { id: row.id, reporterRemindedAt: null },
          data: { reporterRemindedAt: now },
        });
        if (marked.count === 0) return;
        for (const reporterId of waiting) {
          const own = reports.filter((r) => r.userId === reporterId).map((r) => r.id);
          await emitWebsiteNotice(tx, {
            campaignId: row.campaignId,
            kind: "CAMPAIGN_MEETING_POINT_CONFIRM_REMINDER",
            userIds: [reporterId],
            payload: {
              campaignId: row.campaignId,
              meetingPointId: row.meetingPointId,
              meetingPointName,
              reportId: own[0] ?? "",
              reportTitle: own.map((id) => titles.get(id) ?? "").join(", "),
              ...campaignTitleNotificationPayload(campaign),
            },
            dedupKey: `CAMPAIGN_MEETING_POINT_CONFIRM_REMINDER:${row.id}:${reporterId}`,
          });
          result.reminded += 1;
        }
      });
    } catch (error) {
      console.warn("[campaign] reporter reminder failed", { verificationId: row.id, error });
    }
  }

  // 4. Decide the campaigns whose meeting points moved.
  for (const campaignId of touched) {
    try {
      const decision = await verificationDecisionService.decideCampaign(campaignId, now);
      if (decision !== "wait") result.decided += 1;
    } catch (error) {
      console.warn("[campaign] deciding a campaign after the sweep failed", { campaignId, error });
    }
  }
  return result;
}
