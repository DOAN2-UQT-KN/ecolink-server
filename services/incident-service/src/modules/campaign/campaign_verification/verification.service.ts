import { Prisma } from "@prisma/client";
import {
  CAMPAIGN_AWAITING_ADMIN_REASON,
  CAMPAIGN_COMPLETION_MAX_REJECTIONS,
  CAMPAIGN_COMPLETION_REPORT_STATUS,
  CampaignStatus,
  MEETING_POINT_CANNOT_VOTE,
  MEETING_POINT_DECISION,
  MEETING_POINT_FLAG_DEADLINE_HOURS,
  MEETING_POINT_STATUS,
  MEETING_POINT_VOTE_NOTE_MAX,
  MEETING_POINT_VOTES_PER_DAY,
  MEETING_POINT_VOTING_HOURS,
  MEETING_POINT_WEIGHT_REASON,
  RESULT_CHECK_LEVEL,
  type CampaignAwaitingAdminReasonValue,
  type CampaignCompletionReportStatusValue,
  type MeetingPointCannotVoteValue,
  type MeetingPointDecisionValue,
  type MeetingPointStatusValue,
  type ResultCheckLevelValue,
} from "@da2/constants";
import prisma from "../../../config/prisma.client";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";
import {
  fetchOrganizationOwnersByUserIds,
  fetchUserVoteProfile,
  getUserProfile,
} from "../../organization/identity-user.client";
import { getCampaignAdminNotifyUserIds } from "../campaign-completion-admin-notify.config";
import { campaignAccessService, isPlatformAdmin } from "../campaign-access.service";
import { campaignTitleNotificationPayload } from "../campaign-i18n";
import { haversineKm } from "../campaign-submit-validation";
import { CAMPAIGN_INCLUDE, type CampaignWithReports } from "../campaign.entity";
import type { CompletionReportRow } from "../campaign_completion/completion.service";
import {
  layer1ForPoints,
  type Layer1Issue,
  type PointLayer1View,
} from "../campaign_shift_result/result-photo.service";
import {
  campaignTeamIds,
  emitWebsiteNotice,
  latestRounds,
  markAwaitingAdmin,
  meetingPointNameOf,
  reportTitles,
  verificationDecisionService,
  type MeetingPointVerificationRow,
} from "./verification-decision.service";
import {
  failedReportsOf,
  meetingPointLayer1Level,
  nearestDistanceM,
  pointAfterVote,
  tally,
  voteWeight,
  type MeetingPointLayer1Entry,
  type PointTransition,
} from "./verification-rules";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

const HOUR_MS = 60 * 60 * 1000;
const HTTP_URL = /^https?:\/\/\S+$/i;

export type VoteValueInput = "up" | "down";

export interface MeetingPointVoteInput {
  value: VoteValueInput;
  note?: string | null;
  photoUrl?: string | null;
  /** Downvote: the trash points of the round that are not clean (at least one). */
  reportIds?: string[] | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
}

export interface MeetingPointVoteView {
  userId: string;
  user: { id: string; name: string; avatar: string | null } | null;
  value: VoteValueInput;
  /** Weight, its reason and the distance: admins and the campaign's managers only (null otherwise). */
  weight: number | null;
  weightReason: string | null;
  distanceM: number | null;
  note: string | null;
  photoUrl: string | null;
  /** Downvote: the trash points said not clean. */
  flaggedReportIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** A trash point of a meeting point under verification. */
export interface MeetingPointTrashPointView {
  reportId: string;
  report: {
    title: string | null;
    detailAddress: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  /** As declared in the submission; only `cleaned` ones are part of the vote. */
  status: CampaignCompletionReportStatusValue;
  beforeUrls: string[];
  afterUrls: string[];
  /** Layer 1 stored when the round opened (cleaned trash points of the round); null otherwise. */
  layer1: PointLayer1View | null;
  /** The viewer reported this trash point. */
  isMine: boolean;
}

/** One meeting point under result verification (latest round), as the viewer sees it. */
export interface MeetingPointView {
  verificationId: string;
  meetingPointId: string;
  name: string | null;
  detailAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  round: number;
  status: MeetingPointStatusValue;
  /** The worst of the cleaned trash points' Layer 1. */
  layer1Level: ResultCheckLevelValue;
  /** The viewer's own trash points first, then the cleaned ones, in the campaign's order. */
  trashPoints: MeetingPointTrashPointView[];
  windowEndsAt: Date;
  flaggedAt: Date | null;
  flagDeadline: Date | null;
  decidedAt: Date | null;
  decisionCode: MeetingPointDecisionValue | null;
  decisionReason: string | null;
  /** Rejected: the trash points that did not pass. */
  failedReportIds: string[];
  upCount: number;
  downCount: number;
  /** The viewer reported a trash point of this meeting point (Layer 2: their vote weighs 10). */
  isReporter: boolean;
  myVote:
    | (Omit<MeetingPointVoteView, "userId" | "user" | "distanceM" | "weight" | "weightReason"> & {
        weight: number;
        weightReason: string;
      })
    | null;
  canVote: boolean;
  cannotVoteReason: MeetingPointCannotVoteValue | null;
  /** Admins and the campaign's managers only (null otherwise). */
  score: number | null;
  /** Every vote with its voter; weights and distances only for admins and managers. */
  votes: MeetingPointVoteView[];
}

/** GET /campaigns/:id/verification. */
export interface CampaignVerificationView {
  campaignId: string;
  campaignStatus: number;
  completionSubmittedAt: Date | null;
  awaitingAdmin: boolean;
  awaitingAdminReason: CampaignAwaitingAdminReasonValue | null;
  rejectionCount: number;
  maxRejections: number;
  /** Admins and the campaign's managers see scores and every vote. */
  canSeeVotes: boolean;
  /** Platform admin: may decide flagged meeting points. */
  canDecide: boolean;
  /** Why the viewer may not vote on this campaign at all (org member, manager, volunteer). */
  cannotVoteReason: MeetingPointCannotVoteValue | null;
  meetingPoints: MeetingPointView[];
}

interface Viewer {
  userId: string;
  role?: string | null;
}

export function awaitingAdminReason(campaign: {
  completionAwaitingAdmin: boolean;
  completionRejectionCount: number;
}): CampaignAwaitingAdminReasonValue | null {
  if (!campaign.completionAwaitingAdmin) return null;
  return campaign.completionRejectionCount >= CAMPAIGN_COMPLETION_MAX_REJECTIONS
    ? CAMPAIGN_AWAITING_ADMIN_REASON.REJECTION_LIMIT
    : CAMPAIGN_AWAITING_ADMIN_REASON.NO_CLEANED_POINTS;
}

const toValue = (v: number): VoteValueInput => (v > 0 ? "up" : "down");
export const layer1Of = (row: { layer1: Prisma.JsonValue }) =>
  (row.layer1 ?? []) as unknown as MeetingPointLayer1Entry[];

/**
 * Result verification, Layers 2 and 3 (spec version 2): rounds open when the campaign is marked
 * done, one per meeting point holding a trash point declared cleaned; residents vote on the
 * meeting point with a weight (a downvote names the trash points not clean); each vote may verify
 * or flag it at once; the admin decides flagged meeting points. The campaign is then decided from
 * its meeting points (`verificationDecisionService`).
 */
export class CampaignVerificationService {
  // ---------------------------------------------------------------------------
  // Opening rounds (marking done)
  // ---------------------------------------------------------------------------

  /**
   * Inside the marking-done transaction: a new round (72 h window) for each meeting point that
   * holds a trash point declared cleaned and is not verified yet, with each such trash point's
   * Layer 1 and the meeting point's (the worst). The original reporters of those trash points are
   * asked first: one priority notice per reporter and meeting point. Nothing declared cleaned:
   * the admin decides. Returns how many rounds opened.
   */
  async openRounds(
    tx: Tx,
    campaign: CampaignWithReports,
    rows: CompletionReportRow[],
    now: Date,
  ): Promise<{ opened: number; cleaned: number }> {
    const cleaned = rows.filter((r) => r.status === CAMPAIGN_COMPLETION_REPORT_STATUS.CLEANED);
    const links = cleaned.length
      ? await tx.campaignMeetingPointReport.findMany({
          where: {
            campaignId: campaign.id,
            reportId: { in: cleaned.map((r) => r.reportId) },
            meetingPoint: { deletedAt: null },
          },
          select: { reportId: true, meetingPointId: true },
          orderBy: { createdAt: "asc" },
        })
      : [];
    if (links.length === 0) {
      await markAwaitingAdmin(tx, campaign, {
        reason: CAMPAIGN_AWAITING_ADMIN_REASON.NO_CLEANED_POINTS,
        submittedAt: now,
      });
      return { opened: 0, cleaned: 0 };
    }
    const cleanedOf = new Map<string, CompletionReportRow[]>();
    const rowById = new Map(cleaned.map((r) => [r.reportId, r]));
    for (const l of links) {
      const list = cleanedOf.get(l.meetingPointId) ?? [];
      list.push(rowById.get(l.reportId)!);
      cleanedOf.set(l.meetingPointId, list);
    }
    const existing = await tx.meetingPointVerification.findMany({
      where: { campaignId: campaign.id, meetingPointId: { in: [...cleanedOf.keys()] } },
      orderBy: { round: "desc" },
      select: { meetingPointId: true, round: true, status: true },
    });
    const latest = new Map<string, { round: number; status: string }>();
    for (const e of existing) if (!latest.has(e.meetingPointId)) latest.set(e.meetingPointId, e);
    const toOpen = [...cleanedOf.keys()].filter(
      (id) => latest.get(id)?.status !== MEETING_POINT_STATUS.VERIFIED,
    );
    if (toOpen.length === 0) return { opened: 0, cleaned: links.length };

    const openRows = toOpen.flatMap((id) => cleanedOf.get(id)!);
    const [layer1, reports, blocked, organization, points] = await Promise.all([
      layer1ForPoints(campaign.id, openRows, tx),
      tx.report.findMany({
        where: { id: { in: openRows.map((r) => r.reportId) } },
        select: { id: true, userId: true, title: true, titleVi: true },
      }),
      this.blockedVoterIds(tx, campaign),
      tx.organization.findUnique({ where: { id: campaign.organizationId }, select: { name: true } }),
      tx.campaignMeetingPoint.findMany({
        where: { id: { in: toOpen } },
        select: { id: true, name: true, sortOrder: true },
      }),
    ]);
    const reportById = new Map(reports.map((r) => [r.id, r]));
    const pointById = new Map(points.map((p) => [p.id, p]));
    const windowEndsAt = new Date(now.getTime() + MEETING_POINT_VOTING_HOURS * HOUR_MS);
    for (const meetingPointId of toOpen) {
      const own = cleanedOf.get(meetingPointId)!;
      const entries: MeetingPointLayer1Entry[] = own.map((r) => {
        const l1 = layer1.get(r.reportId);
        return {
          reportId: r.reportId,
          level: l1?.level ?? RESULT_CHECK_LEVEL.WARN,
          issues: l1?.issues ?? [],
          beforeUrls: r.beforeUrls,
          afterUrls: r.afterUrls,
        };
      });
      // One Layer 2 vote per reporter, however many of the meeting point's trash points they reported.
      const reportsOfReporter = new Map<string, string[]>();
      for (const r of own) {
        const userId = reportById.get(r.reportId)?.userId;
        if (!userId) continue;
        reportsOfReporter.set(userId, [...(reportsOfReporter.get(userId) ?? []), r.reportId]);
      }
      const created = await tx.meetingPointVerification.create({
        data: {
          campaignId: campaign.id,
          meetingPointId,
          round: (latest.get(meetingPointId)?.round ?? 0) + 1,
          status: MEETING_POINT_STATUS.VOTING,
          reportIds: own.map((r) => r.reportId),
          reporterIds: [...reportsOfReporter.keys()],
          layer1Level: meetingPointLayer1Level(entries.map((e) => e.level)),
          layer1: entries as unknown as Prisma.InputJsonValue,
          windowEndsAt,
          createdAt: now,
        },
      });
      const p = pointById.get(meetingPointId);
      const meetingPointName = p ? p.name || `#${p.sortOrder + 1}` : "";
      for (const [reporterId, reportIds] of reportsOfReporter) {
        if (blocked.has(reporterId)) continue;
        await emitWebsiteNotice(tx, {
          campaignId: campaign.id,
          kind: "CAMPAIGN_MEETING_POINT_CONFIRM_REQUEST",
          userIds: [reporterId],
          payload: {
            campaignId: campaign.id,
            meetingPointId,
            meetingPointName,
            reportId: reportIds[0],
            reportTitle: reportIds
              .map((id) => reportById.get(id))
              .map((r) => r?.titleVi || r?.title || "")
              .filter(Boolean)
              .join(", "),
            organizationName: organization?.name ?? "",
            ...campaignTitleNotificationPayload(campaign),
          },
          dedupKey: `CAMPAIGN_MEETING_POINT_CONFIRM_REQUEST:${created.id}:${reporterId}`,
        });
      }
    }
    return { opened: toOpen.length, cleaned: links.length };
  }

  /** Who may not vote at all: the organization's members, the campaign's managers, attendees. */
  async blockedVoterIds(
    db: Db,
    campaign: Pick<CampaignWithReports, "id" | "organizationId" | "createdBy" | "campaignManagers">,
  ) {
    const [members, attendees] = await Promise.all([
      db.organizationMember.findMany({
        where: { organizationId: campaign.organizationId, deletedAt: null },
        select: { userId: true },
      }),
      db.campaignShiftAttendance.findMany({
        where: { campaignId: campaign.id },
        select: { userId: true },
        distinct: ["userId"],
      }),
    ]);
    return new Set([
      ...members.map((m) => m.userId),
      ...attendees.map((a) => a.userId),
      ...campaign.campaignManagers.map((m) => m.userId),
      ...(campaign.createdBy ? [campaign.createdBy] : []),
    ]);
  }

  /** Why this person may not vote on the campaign's meeting points, or null. */
  private async voterBlock(
    campaign: Pick<CampaignWithReports, "id" | "organizationId" | "createdBy" | "campaignManagers">,
    userId: string,
  ): Promise<MeetingPointCannotVoteValue | null> {
    if (campaign.campaignManagers.some((m) => m.userId === userId)) return MEETING_POINT_CANNOT_VOTE.CAMPAIGN_MANAGER;
    const [member, attended] = await Promise.all([
      prisma.organizationMember.findFirst({
        where: { organizationId: campaign.organizationId, userId, deletedAt: null },
        select: { userId: true },
      }),
      prisma.campaignShiftAttendance.count({ where: { campaignId: campaign.id, userId } }),
    ]);
    if (member || campaign.createdBy === userId) return MEETING_POINT_CANNOT_VOTE.ORG_MEMBER;
    if (attended > 0) return MEETING_POINT_CANNOT_VOTE.VOLUNTEER;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Meeting point transitions (votes, the sweep, the admin)
  // ---------------------------------------------------------------------------

  /**
   * Moves a meeting point's round (compare-and-set on its status) and tells who needs to know:
   * admins of a flagged one, owners and managers of a rejected one. A rejection records the trash
   * points that did not pass: the admin's, else `failedReportsOf`. False if it changed meanwhile.
   */
  async transitionPoint(
    tx: Tx,
    row: MeetingPointVerificationRow,
    to: PointTransition,
    ctx: {
      campaign: Pick<CampaignWithReports, "id" | "organizationId" | "createdBy" | "campaignManagers" | "title" | "titleVi" | "titleEn">;
      now: Date;
      decidedBy?: string | null;
      reason?: string | null;
      failedReportIds?: string[];
    },
  ): Promise<boolean> {
    const { now } = ctx;
    const decided = to.status === MEETING_POINT_STATUS.VERIFIED || to.status === MEETING_POINT_STATUS.REJECTED;
    let failedReportIds: string[] = [];
    if (to.status === MEETING_POINT_STATUS.REJECTED) {
      failedReportIds =
        ctx.failedReportIds ??
        failedReportsOf(
          { reportIds: row.reportIds, layer1: layer1Of(row) },
          await tx.meetingPointVote.findMany({
            where: { verificationId: row.id },
            select: { value: true, weight: true, flaggedReportIds: true },
          }),
          to.code,
        );
    }
    const updated = await tx.meetingPointVerification.updateMany({
      where: { id: row.id, status: row.status },
      data: {
        status: to.status,
        ...(to.status === MEETING_POINT_STATUS.FLAGGED
          ? { flaggedAt: now, flagDeadline: new Date(now.getTime() + MEETING_POINT_FLAG_DEADLINE_HOURS * HOUR_MS) }
          : {}),
        ...(decided
          ? {
              decidedAt: now,
              decidedBy: ctx.decidedBy ?? null,
              decisionCode: to.code,
              decisionReason: ctx.reason ?? null,
              failedReportIds,
            }
          : {}),
      },
    });
    if (updated.count === 0) return false;

    const base = {
      campaignId: ctx.campaign.id,
      meetingPointId: row.meetingPointId,
      meetingPointName: await meetingPointNameOf(row.meetingPointId),
      ...campaignTitleNotificationPayload(ctx.campaign),
    };
    if (to.status === MEETING_POINT_STATUS.FLAGGED) {
      await emitWebsiteNotice(tx, {
        campaignId: ctx.campaign.id,
        kind: "CAMPAIGN_MEETING_POINT_FLAGGED",
        userIds: getCampaignAdminNotifyUserIds(),
        payload: base,
        dedupKey: `CAMPAIGN_MEETING_POINT_FLAGGED:${row.id}`,
      });
    } else if (to.status === MEETING_POINT_STATUS.REJECTED) {
      const titles = await reportTitles(ctx.campaign.id, failedReportIds);
      await emitWebsiteNotice(tx, {
        campaignId: ctx.campaign.id,
        kind: "CAMPAIGN_MEETING_POINT_REJECTED",
        userIds: await campaignTeamIds(ctx.campaign),
        payload: {
          ...base,
          reason: ctx.reason ?? "",
          failedReports: failedReportIds.map((id) => titles.get(id) ?? "").join(", "),
        },
        dedupKey: `CAMPAIGN_MEETING_POINT_REJECTED:${row.id}`,
      });
    }
    return true;
  }

  private async loadCampaign(campaignId: string): Promise<CampaignWithReports> {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, deletedAt: null },
      include: CAMPAIGN_INCLUDE,
    });
    if (!campaign) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"));
    return campaign;
  }

  private async currentRound(campaignId: string, meetingPointId: string): Promise<MeetingPointVerificationRow> {
    const row = (await latestRounds(prisma, campaignId)).find((r) => r.meetingPointId === meetingPointId);
    if (!row) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("This meeting point is not under verification"));
    return row;
  }

  /** Distinct ids of the round's trash points among `ids`; null when empty or one is not of the round. */
  private roundReportIds(row: MeetingPointVerificationRow, ids: string[] | null | undefined): string[] | null {
    const list = [...new Set((ids ?? []).map((id) => String(id).trim()).filter(Boolean))];
    if (list.length === 0 || list.some((id) => !row.reportIds.includes(id))) return null;
    return list;
  }

  // ---------------------------------------------------------------------------
  // Voting (Layers 2 and 3)
  // ---------------------------------------------------------------------------

  /**
   * A resident's vote on a meeting point while its window is open (a flagged one too); changing
   * it is allowed. The weight is the highest the voter qualifies for (kept when a later change
   * qualifies for less). A downvote needs a note or a photo and the trash points not clean. The
   * meeting point is re-scored at once (≥ 15 verified; downvote and ≤ 3 flagged), then the
   * campaign decided.
   */
  async vote(
    campaignId: string,
    meetingPointId: string,
    viewer: Viewer,
    input: MeetingPointVoteInput,
    now = new Date(),
  ): Promise<{ meetingPoint: MeetingPointView; campaignStatus: number }> {
    const userId = viewer.userId;
    const campaign = await this.loadCampaign(campaignId);
    if (campaign.status !== CampaignStatus.PENDING_COMPLETION) throw new HttpError(HTTP_STATUS.MEETING_POINT_VOTE_CLOSED);
    const row = await this.currentRound(campaignId, meetingPointId);
    if (!this.isOpen(row, now)) throw new HttpError(HTTP_STATUS.MEETING_POINT_VOTE_CLOSED);
    const block = await this.voterBlock(campaign, userId);
    if (block) throw new HttpError(HTTP_STATUS.MEETING_POINT_VOTE_NOT_ALLOWED, { reason: block });

    const value = input.value === "up" ? 1 : -1;
    const note = (input.note ?? "").trim().slice(0, MEETING_POINT_VOTE_NOTE_MAX) || null;
    const photoUrl = (input.photoUrl ?? "").trim() || null;
    if (photoUrl && !HTTP_URL.test(photoUrl)) {
      throw new HttpError(HTTP_STATUS.VALIDATION_ERROR.withMessage("photoUrl must be a URL"));
    }
    let flaggedReportIds: string[] = [];
    if (value < 0) {
      if (!note && !photoUrl) throw new HttpError(HTTP_STATUS.MEETING_POINT_VOTE_REASON_REQUIRED);
      const ids = this.roundReportIds(row, input.reportIds);
      if (!ids) throw new HttpError(HTTP_STATUS.MEETING_POINT_VOTE_REPORTS_REQUIRED);
      flaggedReportIds = ids;
    }

    const existing = await prisma.meetingPointVote.findUnique({
      where: { verificationId_userId: { verificationId: row.id, userId } },
    });
    if (!existing) {
      const today = await prisma.meetingPointVote.count({
        where: { userId, createdAt: { gt: new Date(now.getTime() - 24 * HOUR_MS) } },
      });
      if (today >= MEETING_POINT_VOTES_PER_DAY) throw new HttpError(HTTP_STATUS.MEETING_POINT_VOTE_LIMIT);
    }

    const [meetingPoint, reports] = await Promise.all([
      prisma.campaignMeetingPoint.findUnique({
        where: { id: meetingPointId },
        select: { latitude: true, longitude: true },
      }),
      prisma.report.findMany({
        where: { id: { in: row.reportIds } },
        select: { latitude: true, longitude: true },
      }),
    ]);
    const places = [
      meetingPoint,
      ...reports.map((r) =>
        r.latitude != null && r.longitude != null ? { latitude: r.latitude, longitude: r.longitude } : null,
      ),
    ];
    const hasGps =
      input.latitude != null &&
      input.longitude != null &&
      Number.isFinite(input.latitude) &&
      Number.isFinite(input.longitude);
    const gpsDistanceM = hasGps
      ? nearestDistanceM({ latitude: input.latitude!, longitude: input.longitude! }, places, haversineKm)
      : null;
    const anchor = places.find((p) => p != null) ?? null;
    const profile = await fetchUserVoteProfile({
      userId,
      latitude: anchor?.latitude ?? 0,
      longitude: anchor?.longitude ?? 0,
    });
    if (!profile) {
      throw new HttpError(HTTP_STATUS.SERVICE_UNAVAILABLE.withMessage("Could not check your account; try again"));
    }
    let weight = voteWeight({
      isReporter: row.reporterIds.includes(userId),
      gpsDistanceM,
      gpsAccuracyM: input.accuracy ?? null,
      savedLocationDistanceM: anchor ? profile.savedLocationDistanceM : null,
      accountCreatedAt: profile.createdAt,
      emailVerified: profile.emailVerified,
      now,
    });
    const zeroedByAccount =
      weight.reason === MEETING_POINT_WEIGHT_REASON.ZERO_NEW_ACCOUNT ||
      weight.reason === MEETING_POINT_WEIGHT_REASON.ZERO_UNVERIFIED;
    if (existing && !zeroedByAccount && existing.weight > weight.weight) {
      weight = { weight: existing.weight, reason: existing.weightReason as typeof weight.reason };
    }

    await prisma.$transaction(async (tx) => {
      // One vote at a time per meeting point, so the score and the transition agree.
      await tx.$queryRaw`SELECT id FROM meeting_point_verifications WHERE id = ${row.id}::uuid FOR UPDATE`;
      const fresh = await tx.meetingPointVerification.findUniqueOrThrow({ where: { id: row.id } });
      if (!this.isOpen(fresh, now)) throw new HttpError(HTTP_STATUS.MEETING_POINT_VOTE_CLOSED);
      const data = {
        value,
        weight: weight.weight,
        weightReason: weight.reason,
        latitude: hasGps ? input.latitude! : null,
        longitude: hasGps ? input.longitude! : null,
        accuracy: hasGps ? (input.accuracy ?? null) : null,
        distanceM: gpsDistanceM,
        note,
        photoUrl,
        flaggedReportIds,
        updatedAt: now,
      };
      await tx.meetingPointVote.upsert({
        where: { verificationId_userId: { verificationId: row.id, userId } },
        create: { verificationId: row.id, userId, ...data, createdAt: now },
        update: data,
      });
      const votes = await tx.meetingPointVote.findMany({
        where: { verificationId: row.id },
        select: { value: true, weight: true },
      });
      const { score, hasDownvote } = tally(votes);
      await tx.meetingPointVerification.update({ where: { id: row.id }, data: { score } });
      const next = pointAfterVote({ status: fresh.status as MeetingPointStatusValue, score, hasDownvote });
      if (next) await this.transitionPoint(tx, fresh, next, { campaign, now });
    });

    await this.decideAfter(campaignId, now);
    return this.pointResult(campaignId, meetingPointId, viewer, now);
  }

  /**
   * A resident takes their vote back while the window is open (nothing to do without one). The
   * meeting point is re-scored; its status only moves forward (a flagged one stays flagged), then
   * the campaign is decided. Voting again weighs the vote afresh.
   */
  async unvote(
    campaignId: string,
    meetingPointId: string,
    viewer: Viewer,
    now = new Date(),
  ): Promise<{ meetingPoint: MeetingPointView; campaignStatus: number }> {
    const campaign = await this.loadCampaign(campaignId);
    if (campaign.status !== CampaignStatus.PENDING_COMPLETION) throw new HttpError(HTTP_STATUS.MEETING_POINT_VOTE_CLOSED);
    const row = await this.currentRound(campaignId, meetingPointId);
    if (!this.isOpen(row, now)) throw new HttpError(HTTP_STATUS.MEETING_POINT_VOTE_CLOSED);

    const removed = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM meeting_point_verifications WHERE id = ${row.id}::uuid FOR UPDATE`;
      const fresh = await tx.meetingPointVerification.findUniqueOrThrow({ where: { id: row.id } });
      if (!this.isOpen(fresh, now)) throw new HttpError(HTTP_STATUS.MEETING_POINT_VOTE_CLOSED);
      const { count } = await tx.meetingPointVote.deleteMany({
        where: { verificationId: row.id, userId: viewer.userId },
      });
      if (count === 0) return false;
      const votes = await tx.meetingPointVote.findMany({
        where: { verificationId: row.id },
        select: { value: true, weight: true },
      });
      const { score, hasDownvote } = tally(votes);
      await tx.meetingPointVerification.update({ where: { id: row.id }, data: { score } });
      const next = pointAfterVote({ status: fresh.status as MeetingPointStatusValue, score, hasDownvote });
      if (next) await this.transitionPoint(tx, fresh, next, { campaign, now });
      return true;
    });

    if (removed) await this.decideAfter(campaignId, now);
    return this.pointResult(campaignId, meetingPointId, viewer, now);
  }

  /**
   * Admin, a flagged meeting point: verified, or rejected with a reason and the trash points that
   * did not pass (their shifts reopen if the campaign is rejected). Then the campaign is decided.
   */
  async decide(
    campaignId: string,
    meetingPointId: string,
    adminUserId: string,
    input: { decision: "verify" | "reject"; reason?: string | null; reportIds?: string[] | null },
    now = new Date(),
  ): Promise<{ meetingPoint: MeetingPointView; campaignStatus: number }> {
    const campaign = await this.loadCampaign(campaignId);
    if (campaign.status !== CampaignStatus.PENDING_COMPLETION) {
      throw new HttpError(
        HTTP_STATUS.CAMPAIGN_INVALID_TRANSITION.withMessage("The campaign is not waiting for completion"),
      );
    }
    const row = await this.currentRound(campaignId, meetingPointId);
    if (row.status !== MEETING_POINT_STATUS.FLAGGED) throw new HttpError(HTTP_STATUS.MEETING_POINT_NOT_FLAGGED);
    const reason = input.reason?.trim() || null;
    let failedReportIds: string[] | undefined;
    if (input.decision === "reject") {
      if (!reason) throw new HttpError(HTTP_STATUS.VALIDATION_ERROR.withMessage("A reason is required to reject"));
      const ids = this.roundReportIds(row, input.reportIds);
      if (!ids) throw new HttpError(HTTP_STATUS.MEETING_POINT_REJECT_REPORTS_REQUIRED);
      failedReportIds = ids;
    }
    const to: PointTransition = {
      status: input.decision === "verify" ? MEETING_POINT_STATUS.VERIFIED : MEETING_POINT_STATUS.REJECTED,
      code: MEETING_POINT_DECISION.ADMIN,
    };
    const moved = await prisma.$transaction((tx) =>
      this.transitionPoint(tx, row, to, { campaign, now, decidedBy: adminUserId, reason, failedReportIds }),
    );
    if (!moved) throw new HttpError(HTTP_STATUS.MEETING_POINT_NOT_FLAGGED);
    await this.decideAfter(campaignId, now);
    return this.pointResult(campaignId, meetingPointId, { userId: adminUserId, role: "admin" }, now);
  }

  /** The campaign decision never fails the vote or the admin's decision that triggered it. */
  private async decideAfter(campaignId: string, now: Date) {
    try {
      await verificationDecisionService.decideCampaign(campaignId, now);
    } catch (error) {
      console.error("[campaign] result verification: deciding the campaign failed", { campaignId, error });
    }
  }

  private isOpen(row: { status: string; windowEndsAt: Date }, now: Date) {
    return (
      (row.status === MEETING_POINT_STATUS.VOTING || row.status === MEETING_POINT_STATUS.FLAGGED) &&
      now.getTime() < row.windowEndsAt.getTime()
    );
  }

  private async pointResult(campaignId: string, meetingPointId: string, viewer: Viewer, now: Date) {
    const view = await this.getView(campaignId, viewer, now);
    const meetingPoint = view.meetingPoints.find((p) => p.meetingPointId === meetingPointId);
    if (!meetingPoint) {
      throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("This meeting point is not under verification"));
    }
    return { meetingPoint, campaignStatus: view.campaignStatus };
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /**
   * Every meeting point under verification (latest round). Anyone signed in once the campaign
   * waits for completion or is completed; admins and its managers in every status, with scores
   * and votes.
   */
  async getView(campaignId: string, viewer: Viewer, now = new Date()): Promise<CampaignVerificationView> {
    const campaign = await this.loadCampaign(campaignId);
    const admin = isPlatformAdmin(viewer.role);
    const canManage = admin ? false : await campaignAccessService.canManage(campaign, viewer.userId);
    const canSeeVotes = admin || canManage;
    const isPublic =
      campaign.status === CampaignStatus.PENDING_COMPLETION || campaign.status === CampaignStatus.COMPLETED;
    if (!canSeeVotes && !isPublic) throw new HttpError(HTTP_STATUS.CAMPAIGN_PERMISSION_DENIED);

    const rounds = await latestRounds(prisma, campaignId);
    const meetingPoints = await this.toPointViews(campaign, rounds, viewer, canSeeVotes, now);
    return {
      campaignId,
      campaignStatus: campaign.status,
      completionSubmittedAt: campaign.completionSubmittedAt,
      awaitingAdmin: campaign.completionAwaitingAdmin,
      awaitingAdminReason: awaitingAdminReason(campaign),
      rejectionCount: campaign.completionRejectionCount,
      maxRejections: CAMPAIGN_COMPLETION_MAX_REJECTIONS,
      canSeeVotes,
      canDecide: admin,
      cannotVoteReason: await this.voterBlock(campaign, viewer.userId),
      meetingPoints,
    };
  }

  /** Meeting point views for the admin's review (every vote, with its weight). */
  async pointsForReview(campaign: CampaignWithReports, viewer: Viewer, now = new Date()) {
    return this.toPointViews(campaign, await latestRounds(prisma, campaign.id), viewer, true, now);
  }

  private async toPointViews(
    campaign: CampaignWithReports,
    rounds: MeetingPointVerificationRow[],
    viewer: Viewer,
    canSeeVotes: boolean,
    now: Date,
  ): Promise<MeetingPointView[]> {
    if (rounds.length === 0) return [];
    const meetingPointIds = rounds.map((r) => r.meetingPointId);
    const links = await prisma.campaignMeetingPointReport.findMany({
      where: { campaignId: campaign.id, meetingPointId: { in: meetingPointIds } },
      select: { reportId: true, meetingPointId: true },
      orderBy: { createdAt: "asc" },
    });
    const allReportIds = [...new Set([...links.map((l) => l.reportId), ...rounds.flatMap((r) => r.reportIds)])];
    const [points, reports, snapshot, votes, layer1, block] = await Promise.all([
      prisma.campaignMeetingPoint.findMany({
        where: { id: { in: meetingPointIds } },
        select: { id: true, name: true, detailAddress: true, latitude: true, longitude: true, sortOrder: true },
      }),
      prisma.report.findMany({
        where: { id: { in: allReportIds } },
        select: { id: true, userId: true, title: true, detailAddress: true, latitude: true, longitude: true },
      }),
      prisma.campaignCompletionReport.findMany({
        where: { campaignId: campaign.id, reportId: { in: allReportIds } },
        select: { reportId: true, status: true, beforeUrls: true, afterUrls: true },
      }),
      prisma.meetingPointVote.findMany({
        where: { verificationId: { in: rounds.map((r) => r.id) } },
        orderBy: { createdAt: "asc" },
      }),
      layer1ForPoints(campaign.id, rounds.flatMap(layer1Of)),
      campaign.status === CampaignStatus.PENDING_COMPLETION
        ? this.voterBlock(campaign, viewer.userId)
        : Promise.resolve(null),
    ]);
    const profiles = await fetchOrganizationOwnersByUserIds([...new Set(votes.map((v) => v.userId))]);
    const pointById = new Map(points.map((p) => [p.id, p]));
    const reportById = new Map(reports.map((r) => [r.id, r]));
    const snapshotOf = new Map(snapshot.map((s) => [s.reportId, s]));
    const order = new Map(links.map((l, i) => [l.reportId, i]));
    const campaignOpen = campaign.status === CampaignStatus.PENDING_COMPLETION;

    const view = (r: MeetingPointVerificationRow): MeetingPointView => {
      const p = pointById.get(r.meetingPointId);
      const own = votes.filter((v) => v.verificationId === r.id);
      const mine = own.find((v) => v.userId === viewer.userId) ?? null;
      const open = campaignOpen && this.isOpen(r, now);
      const cannotVoteReason: MeetingPointCannotVoteValue | null = !open ? MEETING_POINT_CANNOT_VOTE.CLOSED : block;
      const entryOf = new Map(layer1Of(r).map((e) => [e.reportId, e]));
      const ids = [
        ...r.reportIds,
        ...links
          .filter((l) => l.meetingPointId === r.meetingPointId && !entryOf.has(l.reportId))
          .map((l) => l.reportId),
      ];
      const trashPoints: MeetingPointTrashPointView[] = ids.map((reportId) => {
        const report = reportById.get(reportId);
        const entry = entryOf.get(reportId);
        const snap = snapshotOf.get(reportId);
        return {
          reportId,
          report: report
            ? {
                title: report.title,
                detailAddress: report.detailAddress,
                latitude: report.latitude,
                longitude: report.longitude,
              }
            : null,
          status: entry
            ? CAMPAIGN_COMPLETION_REPORT_STATUS.CLEANED
            : ((snap?.status as CampaignCompletionReportStatusValue | undefined) ??
              CAMPAIGN_COMPLETION_REPORT_STATUS.UNHANDLED),
          beforeUrls: entry?.beforeUrls ?? snap?.beforeUrls ?? [],
          afterUrls: entry?.afterUrls ?? snap?.afterUrls ?? [],
          layer1: entry
            ? {
                level: entry.level,
                issues: entry.issues as Layer1Issue[],
                photos: layer1.get(reportId)?.photos ?? [],
              }
            : null,
          isMine: report?.userId != null && report.userId === viewer.userId,
        };
      });
      trashPoints.sort(
        (a, b) =>
          Number(b.isMine) - Number(a.isMine) ||
          Number(b.layer1 != null) - Number(a.layer1 != null) ||
          (order.get(a.reportId) ?? 1e9) - (order.get(b.reportId) ?? 1e9),
      );
      return {
        verificationId: r.id,
        meetingPointId: r.meetingPointId,
        name: p?.name ?? null,
        detailAddress: p?.detailAddress ?? null,
        latitude: p?.latitude ?? null,
        longitude: p?.longitude ?? null,
        round: r.round,
        status: r.status as MeetingPointStatusValue,
        layer1Level: r.layer1Level as ResultCheckLevelValue,
        trashPoints,
        windowEndsAt: r.windowEndsAt,
        flaggedAt: r.flaggedAt,
        flagDeadline: r.flagDeadline,
        decidedAt: r.decidedAt,
        decisionCode: r.decisionCode as MeetingPointDecisionValue | null,
        decisionReason: r.decisionReason,
        failedReportIds: r.failedReportIds,
        upCount: own.filter((v) => v.value > 0).length,
        downCount: own.filter((v) => v.value < 0).length,
        isReporter: r.reporterIds.includes(viewer.userId),
        myVote: mine
          ? {
              value: toValue(mine.value),
              weight: mine.weight,
              weightReason: mine.weightReason,
              note: mine.note,
              photoUrl: mine.photoUrl,
              flaggedReportIds: mine.flaggedReportIds,
              createdAt: mine.createdAt,
              updatedAt: mine.updatedAt,
            }
          : null,
        canVote: cannotVoteReason == null,
        cannotVoteReason,
        score: canSeeVotes ? r.score : null,
        votes: own.map((v) => {
          const prof = getUserProfile(profiles, v.userId);
          return {
            userId: v.userId,
            user: prof ? { id: prof.id, name: prof.name, avatar: prof.avatar } : null,
            value: toValue(v.value),
            weight: canSeeVotes ? v.weight : null,
            weightReason: canSeeVotes ? v.weightReason : null,
            distanceM: canSeeVotes ? v.distanceM : null,
            note: v.note,
            photoUrl: v.photoUrl,
            flaggedReportIds: v.flaggedReportIds,
            createdAt: v.createdAt,
            updatedAt: v.updatedAt,
          };
        }),
      };
    };

    return [...rounds]
      .sort(
        (a, b) =>
          (pointById.get(a.meetingPointId)?.sortOrder ?? 1e9) - (pointById.get(b.meetingPointId)?.sortOrder ?? 1e9),
      )
      .map(view);
  }
}

export const campaignVerificationService = new CampaignVerificationService();
