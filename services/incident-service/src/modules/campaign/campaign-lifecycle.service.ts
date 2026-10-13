import { findTeamIds } from "./campaign_manager/campaign-team";
import { Prisma } from "@prisma/client";
import {
  CAMPAIGN_DAY_MAX,
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
  CampaignDayInput,
  CampaignShiftInput,
  CampaignStatusLogResponse,
  MeetingPointInput,
} from "./campaign.dto";
import { CAMPAIGN_INCLUDE, type CampaignWithReports } from "./campaign.entity";
import { enqueueWebsiteNotificationsToUsers } from "./notification-jobs.client";
import { emitOutbox } from "../../outbox/outbox.writer";
import { OutboxEventType } from "../../outbox/outbox.types";

const DAY_MS = 24 * 60 * 60 * 1000;

type Tx = Prisma.TransactionClient;

/** A meeting point as stored, normalized from a request. */
export interface NormalizedMeetingPoint {
  name: string | null;
  latitude: number;
  longitude: number;
  detailAddress: string | null;
  radiusKm: number;
  reportIds: string[];
}

export interface NormalizedDay {
  startAt: Date;
  endAt: Date;
}

/** One cell of the day × meeting point grid, by position. */
export interface NormalizedShift {
  dayIndex: number;
  meetingPointIndex: number;
  /** Working window; null = the day's hours. */
  startAt: Date | null;
  endAt: Date | null;
  gatherAt: Date | null;
  /** 0 = the shift is off. */
  minVolunteers: number;
  maxVolunteers: number | null;
  leaderUserId: string | null;
}

/** A campaign's whole schedule; `shifts` holds every day × meeting point, days in time order. */
export interface NormalizedSchedule {
  days: NormalizedDay[];
  meetingPoints: NormalizedMeetingPoint[];
  shifts: NormalizedShift[];
}

/** What the admin compares between two submissions. */
export interface CampaignSnapshot {
  title: string;
  description: string | null;
  banner: string | null;
  difficulty: number;
  contactName: string | null;
  contactPhone: string | null;
  safetyNotes: string | null;
  requirements: CampaignRequirements | null;
  days: Array<{ startAt: string; endAt: string }>;
  meetingPoints: NormalizedMeetingPoint[];
  shifts: Array<
    Omit<NormalizedShift, "gatherAt" | "startAt" | "endAt"> & {
      startAt: string | null;
      endAt: string | null;
      gatherAt: string | null;
    }
  >;
  minVolunteersReason: string | null;
}

export type FieldDiff = Record<string, { from: unknown; to: unknown }>;

export type ReviewDecision = "approve" | "request_revision" | "block";

function uniqueIds(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

const invalid = (message: string) =>
  new HttpError(HTTP_STATUS.VALIDATION_ERROR.withMessage(message));

export function normalizeMeetingPoints(input: MeetingPointInput[]): NormalizedMeetingPoint[] {
  return input.map((p) => ({
    name: p.name?.trim() || null,
    latitude: Number(p.latitude),
    longitude: Number(p.longitude),
    detailAddress: p.detailAddress?.trim() || null,
    radiusKm: Number(p.radiusKm),
    reportIds: uniqueIds(p.reportIds),
  }));
}

const sameTime = (a: Date | null | undefined, b: Date) => a != null && a.getTime() === b.getTime();

/** The stored schedule of a campaign, in the same shape a request normalizes to. */
export function scheduleOf(campaign: CampaignWithReports): NormalizedSchedule {
  const days = [...(campaign.days ?? [])].sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime(),
  );
  const points = campaign.meetingPoints ?? [];
  const dayIndex = new Map(days.map((d, i) => [d.id, i]));
  const pointIndex = new Map(points.map((p, i) => [p.id, i]));
  const shifts: NormalizedShift[] = [];
  for (const shift of campaign.shifts ?? []) {
    const d = dayIndex.get(shift.dayId);
    const p = pointIndex.get(shift.meetingPointId);
    if (d === undefined || p === undefined) continue;
    const day = days[d];
    shifts.push({
      dayIndex: d,
      meetingPointIndex: p,
      startAt: sameTime(shift.startAt, day.startAt) ? null : shift.startAt,
      endAt: sameTime(shift.endAt, day.endAt) ? null : shift.endAt,
      gatherAt: shift.gatherAt,
      minVolunteers: shift.minVolunteers,
      maxVolunteers: shift.maxVolunteers,
      leaderUserId: shift.leaderUserId,
    });
  }
  shifts.sort((a, b) => a.dayIndex - b.dayIndex || a.meetingPointIndex - b.meetingPointIndex);
  return {
    days: days.map((d) => ({ startAt: d.startAt, endAt: d.endAt })),
    meetingPoints: points.map((p) => ({
      name: p.name,
      latitude: p.latitude,
      longitude: p.longitude,
      detailAddress: p.detailAddress,
      radiusKm: p.radiusKm,
      reportIds: p.reports.map((r) => r.reportId).sort(),
    })),
    shifts,
  };
}

/**
 * The schedule a create/update body asks for, or undefined when it leaves the schedule alone.
 * Any of `days`, `meetingPoints`, `shifts` present replaces the schedule; the parts left out are
 * kept from `current`. Days are put in time order (shifts follow them) and the grid is filled:
 * a day × meeting point without a shift gets one that is off.
 */
export function scheduleFromRequest(
  request: {
    days?: CampaignDayInput[];
    meetingPoints?: MeetingPointInput[];
    shifts?: CampaignShiftInput[];
  },
  current: NormalizedSchedule | null,
  defaultLeaderId: string,
): NormalizedSchedule | undefined {
  if (
    request.days === undefined &&
    request.meetingPoints === undefined &&
    request.shifts === undefined
  ) {
    return undefined;
  }

  const rawDays: NormalizedDay[] =
    request.days?.map((d) => ({ startAt: new Date(d.startAt), endAt: new Date(d.endAt) })) ??
    current?.days ??
    [];
  if (rawDays.length > CAMPAIGN_DAY_MAX) {
    throw invalid(`At most ${CAMPAIGN_DAY_MAX} days`);
  }
  if (rawDays.some((d) => Number.isNaN(d.startAt.getTime()) || Number.isNaN(d.endAt.getTime()))) {
    throw invalid("Every day needs a valid start and end time");
  }
  const meetingPoints =
    request.meetingPoints !== undefined
      ? normalizeMeetingPoints(request.meetingPoints)
      : (current?.meetingPoints ?? []);
  if (meetingPoints.length > CAMPAIGN_MEETING_POINT_MAX) {
    throw invalid(`At most ${CAMPAIGN_MEETING_POINT_MAX} meeting points`);
  }

  const order = rawDays
    .map((day, index) => ({ day, index }))
    .sort((a, b) => a.day.startAt.getTime() - b.day.startAt.getTime());
  const newIndexOf = new Map(order.map((o, i) => [o.index, i]));
  const days = order.map((o) => o.day);

  const given: NormalizedShift[] =
    request.shifts?.map((sh) => ({
      dayIndex: Number(sh.dayIndex),
      meetingPointIndex: Number(sh.meetingPointIndex),
      startAt: sh.startAt ? new Date(sh.startAt) : null,
      endAt: sh.endAt ? new Date(sh.endAt) : null,
      gatherAt: sh.gatherAt ? new Date(sh.gatherAt) : null,
      minVolunteers: Number(sh.minVolunteers ?? 0),
      maxVolunteers: sh.maxVolunteers == null ? null : Number(sh.maxVolunteers),
      leaderUserId: sh.leaderUserId?.trim() || null,
    })) ??
    current?.shifts ??
    [];

  const cells = new Map<string, NormalizedShift>();
  for (const sh of given) {
    const d = newIndexOf.get(sh.dayIndex);
    if (
      d === undefined ||
      !Number.isInteger(sh.meetingPointIndex) ||
      sh.meetingPointIndex < 0 ||
      sh.meetingPointIndex >= meetingPoints.length
    ) {
      // Only an error when the client sent it; stale cells of a kept grid are dropped.
      if (request.shifts !== undefined) throw invalid("A shift points to a missing day or meeting point");
      continue;
    }
    const key = `${d}:${sh.meetingPointIndex}`;
    if (cells.has(key) && request.shifts !== undefined) {
      throw invalid("Each day × meeting point can have only one shift");
    }
    if (sh.gatherAt && Number.isNaN(sh.gatherAt.getTime())) {
      throw invalid("Gathering time must be a valid date");
    }
    if (
      (sh.startAt && Number.isNaN(sh.startAt.getTime())) ||
      (sh.endAt && Number.isNaN(sh.endAt.getTime()))
    ) {
      throw invalid("Shift start and end must be valid dates");
    }
    const day = days[d];
    cells.set(key, {
      ...sh,
      dayIndex: d,
      // The day's own hours are stored as "default", so moving the day moves the shift too.
      startAt: day && sameTime(sh.startAt, day.startAt) ? null : sh.startAt,
      endAt: day && sameTime(sh.endAt, day.endAt) ? null : sh.endAt,
    });
  }

  const shifts: NormalizedShift[] = [];
  days.forEach((_, d) =>
    meetingPoints.forEach((__, p) => {
      const cell = cells.get(`${d}:${p}`);
      shifts.push({
        dayIndex: d,
        meetingPointIndex: p,
        startAt: cell?.startAt ?? null,
        endAt: cell?.endAt ?? null,
        gatherAt: cell?.gatherAt ?? null,
        minVolunteers: cell?.minVolunteers ?? 0,
        maxVolunteers: cell?.maxVolunteers ?? null,
        leaderUserId: cell?.leaderUserId ?? defaultLeaderId,
      });
    }),
  );
  return { days, meetingPoints, shifts };
}

function toSnapshot(campaign: CampaignWithReports): CampaignSnapshot {
  const schedule = scheduleOf(campaign);
  return {
    title: campaign.title,
    description: campaign.description,
    banner: campaign.banner,
    difficulty: campaign.difficulty,
    contactName: campaign.contactName,
    contactPhone: campaign.contactPhone,
    safetyNotes: campaign.safetyNotes,
    requirements: (campaign.requirements as CampaignRequirements | null) ?? null,
    days: schedule.days.map((d) => ({
      startAt: d.startAt.toISOString(),
      endAt: d.endAt.toISOString(),
    })),
    meetingPoints: schedule.meetingPoints,
    shifts: schedule.shifts.map((sh) => ({
      ...sh,
      startAt: sh.startAt?.toISOString() ?? null,
      endAt: sh.endAt?.toISOString() ?? null,
      gatherAt: sh.gatherAt?.toISOString() ?? null,
    })),
    minVolunteersReason: campaign.minVolunteersReason ?? null,
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

/** Spec 3.6: upcoming, running, or approved and under review again after an edit. */
export function isCancellable(campaign: { status: number; approvedAt?: Date | null }): boolean {
  return (
    campaign.status === CampaignStatus.UPCOMING ||
    campaign.status === CampaignStatus.ACTIVE ||
    (campaign.approvedAt != null &&
      (campaign.status === CampaignStatus.PENDING_REVIEW ||
        campaign.status === CampaignStatus.NEEDS_REVISION))
  );
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

  /** Replaces a campaign's days, meeting points (with their reports) and shifts. */
  async replaceSchedule(
    tx: Tx,
    campaignId: string,
    schedule: NormalizedSchedule,
    userId: string,
  ): Promise<void> {
    await tx.campaignShift.deleteMany({ where: { campaignId } });
    await tx.campaignDay.deleteMany({ where: { campaignId } });
    await tx.campaignMeetingPointReport.deleteMany({ where: { campaignId } });
    await tx.campaignMeetingPoint.updateMany({
      where: { campaignId, deletedAt: null },
      data: { deletedAt: new Date(), updatedBy: userId },
    });

    const dayIds: string[] = [];
    for (const [index, day] of schedule.days.entries()) {
      const created = await tx.campaignDay.create({
        data: { campaignId, startAt: day.startAt, endAt: day.endAt, sortOrder: index },
      });
      dayIds.push(created.id);
    }

    const pointIds: string[] = [];
    for (const [index, point] of schedule.meetingPoints.entries()) {
      const created = await tx.campaignMeetingPoint.create({
        data: {
          campaignId,
          name: point.name,
          latitude: point.latitude,
          longitude: point.longitude,
          detailAddress: point.detailAddress,
          radiusKm: point.radiusKm,
          sortOrder: index,
          createdBy: userId,
          updatedBy: userId,
        },
      });
      pointIds.push(created.id);
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

    if (schedule.shifts.length > 0) {
      await tx.campaignShift.createMany({
        data: schedule.shifts.map((sh) => ({
          campaignId,
          dayId: dayIds[sh.dayIndex],
          meetingPointId: pointIds[sh.meetingPointIndex],
          startAt: sh.startAt ?? schedule.days[sh.dayIndex].startAt,
          endAt: sh.endAt ?? schedule.days[sh.dayIndex].endAt,
          gatherAt: sh.gatherAt,
          minVolunteers: sh.minVolunteers,
          maxVolunteers: sh.maxVolunteers,
          leaderUserId: sh.leaderUserId,
        })),
      });
    }

    // The campaign's own location mirrors the first meeting point, for maps and nearby invites.
    const first = schedule.meetingPoints[0];
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

    // Outside the transaction: an HTTP call to reward-service. Unreachable → 503 (thrown by the
    // client); no such level → a field error the form can show on step 1.
    const tier = await rewardServiceClient.getDifficultyByLevelStrict(existing.difficulty);
    if (!tier) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_INVALID, {
        details: [
          {
            field: "difficulty",
            code: "DIFFICULTY_UNKNOWN",
            message: `Difficulty level ${existing.difficulty} does not exist`,
          },
        ],
      });
    }

    const { campaign, isResubmission } = await prisma.$transaction(
      async (tx) => {
        const campaign = await this.loadInTx(tx, id);
        const event: CampaignTransitionEvent =
          campaign.status === CampaignStatus.NEEDS_REVISION ? "resubmit" : "submit";
        // A campaign approved before and sent back by an edit (spec 3.5) is not a new one:
        // the organization's queue limits do not apply, and its days may be close by now.
        const approvedBefore = campaign.approvedAt != null;
        const eligibility = approvedBefore
          ? await campaignEligibilityService.get(userId, campaign.organizationId, {
              db: tx,
              excludeCampaignId: campaign.id,
            })
          : await campaignEligibilityService.assertCanSubmit(
              tx,
              userId,
              campaign.organizationId,
              campaign.id,
            );

        const schedule = scheduleOf(campaign);
        const reportIds = schedule.meetingPoints.flatMap((p) => p.reportIds);
        // Leaders of the shifts that run; an off shift keeps its leader but needs none.
        const leaderIds = [
          ...new Set(
            schedule.shifts
              .filter((sh) => sh.minVolunteers > 0)
              .map((sh) => sh.leaderUserId)
              .filter((x): x is string => !!x),
          ),
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
          findTeamIds(tx, campaign, leaderIds),
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
            days: schedule.days,
            contactName: campaign.contactName,
            contactPhone: campaign.contactPhone,
            difficulty: campaign.difficulty,
            requirements,
            meetingPoints: schedule.meetingPoints,
            shifts: schedule.shifts,
            minVolunteersReason: campaign.minVolunteersReason,
          },
          {
            now: new Date(),
            suggestedMinPerDay: tier.suggestedMinVolunteers,
            maxDifficulty: eligibility.maxDifficulty,
            reports: new Map(reports.map((r) => [r.id, r])),
            eligibleLeaderIds: leaderMembers,
          },
        ).filter((issue) => !(approvedBefore && issue.code === "START_TOO_SOON"));
        if (issues.length > 0) {
          throw new HttpError(HTTP_STATUS.CAMPAIGN_INVALID, { details: issues });
        }

        await this.syncReportLocks(tx, campaign.id, userId);

        // The creator and every shift leader manage the campaign.
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
      select: { id: true, organizationId: true, status: true, approvedAt: true },
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
          decision === "block" &&
          (current.status === CampaignStatus.UPCOMING ||
            current.status === CampaignStatus.ACTIVE)
            ? "ban"
            : decision;
        const data: Omit<Prisma.CampaignUpdateManyMutationInput, "status"> =
          decision === "approve"
            ? { rejectReason: null, revisionDeadline: null, approvedAt: current.approvedAt ?? new Date() }
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

    void this.notifyReviewed(campaign, decision, trimmed, existing.approvedAt != null).catch((err) =>
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
            // Any day started means the first one did.
            days: { some: { startAt: { lte: now } } },
          },
          {
            status: CampaignStatus.NEEDS_REVISION,
            revisionDeadline: { lte: now },
          },
        ],
      },
      select: {
        id: true,
        status: true,
        revisionDeadline: true,
        days: { select: { startAt: true }, orderBy: { startAt: "asc" }, take: 1 },
      },
      take: 200,
    });

    let expired = 0;
    for (const c of candidates) {
      const revisionOverdue =
        c.status === CampaignStatus.NEEDS_REVISION &&
        c.revisionDeadline != null &&
        c.revisionDeadline <= now &&
        !(c.days[0] && c.days[0].startAt <= now);
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

  /** Moves upcoming campaigns to active once their first day has started. */
  async startDueCampaigns(now = new Date()): Promise<number> {
    const candidates = await prisma.campaign.findMany({
      where: {
        deletedAt: null,
        status: CampaignStatus.UPCOMING,
        days: { some: { startAt: { lte: now } } },
      },
      select: { id: true },
      take: 200,
    });

    let started = 0;
    for (const c of candidates) {
      try {
        await prisma.$transaction((tx) =>
          transitionCampaign(tx, {
            campaignId: c.id,
            event: "start",
            fromStatus: CampaignStatus.UPCOMING,
            actor: "system",
            actorId: null,
            reason: null,
          }),
        );
        started += 1;
      } catch (error) {
        // Banned meanwhile; the next sweep re-evaluates.
        console.warn("[campaign] start skipped", { campaignId: c.id, error });
      }
    }
    return started;
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

  /**
   * Organization locked by an admin (spec, exceptions): its draft, under-review and
   * waiting-for-changes campaigns are cancelled and their reports released, inside the caller's
   * transaction. Running campaigns are left to finish. Returns what was cancelled so the caller
   * can notify after commit (`notifyCancelledForLockedOrganization`).
   */
  async cancelForLockedOrganization(
    tx: Tx,
    organizationId: string,
    adminUserId: string,
    reason: string,
  ): Promise<CampaignWithReports[]> {
    const rows = await tx.campaign.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: {
          in: [
            CampaignStatus.DRAFT,
            CampaignStatus.PENDING_REVIEW,
            CampaignStatus.NEEDS_REVISION,
          ],
        },
      },
      select: { id: true, status: true },
    });
    const cancelled: CampaignWithReports[] = [];
    for (const row of rows) {
      await transitionCampaign(tx, {
        campaignId: row.id,
        event: "cancel_org_locked",
        fromStatus: row.status,
        actor: "admin",
        actorId: adminUserId,
        reason,
        data: { rejectReason: reason, revisionDeadline: null },
      });
      await this.releaseAllReports(tx, row.id, adminUserId);
      cancelled.push(await this.loadInTx(tx, row.id));
    }
    return cancelled;
  }

  /**
   * Spec 3.6: the creator or an owner cancels an approved campaign (upcoming, running, or under
   * review again after an edit), with a reason. Its reports go back to the waiting list,
   * registrations stay as history, nobody gets points (completion never follows). Every
   * registered volunteer and the rest of the team hear, through the outbox.
   */
  async cancel(campaignId: string, userId: string, reason: string): Promise<CampaignWithReports> {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, deletedAt: null },
      include: CAMPAIGN_INCLUDE,
    });
    if (!campaign) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"));
    await campaignAccessService.assertCanDelete(campaign, userId);
    if (!isCancellable(campaign)) throw new HttpError(HTTP_STATUS.CAMPAIGN_NOT_CANCELLABLE);
    const text = reason?.trim() ?? "";

    return prisma.$transaction(
      async (tx) => {
        await transitionCampaign(tx, {
          campaignId,
          event: "cancel",
          fromStatus: campaign.status,
          actor: "manager",
          actorId: userId,
          reason: text,
          data: { rejectReason: text, revisionDeadline: null },
        });
        await this.releaseAllReports(tx, campaignId, userId);
        await this.emitCancelledNotices(tx, campaign, { reason: text, actorId: userId, by: "organizer" });
        return this.loadInTx(tx, campaignId);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * `CAMPAIGN_CANCELLED` through the outbox, inside the cancelling transaction: every registered
   * volunteer, and the team (creator, managers, owners) but the one who cancelled. `by` picks the
   * wording: the organizers (spec 3.6) or an admin rejecting the completion (spec 5.2).
   */
  async emitCancelledNotices(
    tx: Tx,
    campaign: Pick<
      CampaignWithReports,
      "id" | "organizationId" | "createdBy" | "campaignManagers" | "title" | "titleVi" | "titleEn"
    >,
    args: { reason: string; actorId: string; by: "organizer" | "admin" },
  ): Promise<void> {
    const campaignId = campaign.id;
    const [volunteers, owners] = await Promise.all([
      tx.campaignShiftRegistration.findMany({
        where: { campaignId, leftAt: null },
        distinct: ["userId"],
        select: { userId: true },
      }),
      organizationMemberRepository.findOwnerUserIds(campaign.organizationId),
    ]);
    const volunteerIds = volunteers.map((v) => v.userId);
    const teamIds = [
      ...new Set([
        ...(campaign.createdBy ? [campaign.createdBy] : []),
        ...campaign.campaignManagers.map((m) => m.userId),
        ...owners,
      ]),
    ].filter((id) => id !== args.actorId && !volunteerIds.includes(id));
    const payload = {
      campaignId,
      reason: args.reason,
      ...(args.by === "admin" ? { byAdmin: "1" } : { byOrganizer: "1" }),
      ...campaignTitleNotificationPayload(campaign),
    };
    for (const [audience, userIds] of [
      ["volunteers", volunteerIds],
      ["team", teamIds],
    ] as const) {
      if (userIds.length === 0) continue;
      await emitOutbox(tx, {
        aggregateType: "campaign",
        aggregateId: campaignId,
        eventType: OutboxEventType.WEBSITE_NOTIFICATION,
        dedupKey: `CAMPAIGN_CANCELLED:${campaignId}:${audience}`,
        payload: { kind: "CAMPAIGN_CANCELLED", userIds, payload },
      });
    }
  }

  /** Creator and owners of each campaign cancelled because its organization was locked. */
  async notifyCancelledForLockedOrganization(
    campaigns: CampaignWithReports[],
    reason: string,
  ): Promise<void> {
    if (campaigns.length === 0) return;
    const owners = await organizationMemberRepository.findOwnerUserIds(
      campaigns[0].organizationId,
    );
    await Promise.all(
      campaigns.map((campaign) => {
        const recipients = [
          ...new Set([...(campaign.createdBy ? [campaign.createdBy] : []), ...owners]),
        ];
        if (recipients.length === 0) return Promise.resolve();
        return enqueueWebsiteNotificationsToUsers({
          kind: "CAMPAIGN_CANCELLED",
          userIds: recipients,
          payload: {
            campaignId: campaign.id,
            reason,
            ...campaignTitleNotificationPayload(campaign),
          },
        });
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Notifications (matrix in the spec)
  // ---------------------------------------------------------------------------

  private async orgName(organizationId: string): Promise<string> {
    const org = await organizationRepository.findById(organizationId).catch(() => null);
    return org?.name ?? "";
  }

  /** Admins hear that an approved campaign is back for review after an edit (spec 3.5). */
  async notifyReReview(campaign: CampaignWithReports): Promise<void> {
    const adminIds = getCampaignAdminNotifyUserIds();
    if (adminIds.length === 0) return;
    const organizationName = await this.orgName(campaign.organizationId);
    await enqueueWebsiteNotificationsToUsers({
      kind: "CAMPAIGN_PENDING_REVIEW",
      userIds: adminIds,
      payload: {
        campaignId: campaign.id,
        organizationId: campaign.organizationId,
        organizationName,
        isResubmission: "true",
        ...campaignTitleNotificationPayload(campaign),
      },
    });
  }

  private async registeredUserIds(campaignId: string): Promise<string[]> {
    const rows = await prisma.campaignShiftRegistration.findMany({
      where: { campaignId, leftAt: null },
      distinct: ["userId"],
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
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
    reReview = false,
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

    if (decision === "approve" && reReview) {
      // Approved again after an edit (spec 3.5): the team and the volunteers who kept their
      // place hear it; the organization's members already did the first time.
      const [managers, volunteers] = await Promise.all([
        this.managerIds(campaign.id),
        this.registeredUserIds(campaign.id),
      ]);
      const recipients = [...new Set([...owners, ...managers, ...volunteers])];
      if (recipients.length > 0) {
        await enqueueWebsiteNotificationsToUsers({
          kind: "CAMPAIGN_APPROVED",
          userIds: recipients,
          payload: base,
        });
      }
      return;
    }

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
    // Under review again after an edit (spec 3.5): its volunteers lose the campaign too.
    if (campaign.approvedAt) {
      const volunteers = await this.registeredUserIds(campaign.id);
      if (volunteers.length > 0) {
        await enqueueWebsiteNotificationsToUsers({
          kind: "CAMPAIGN_REREVIEW_EXPIRED",
          userIds: volunteers,
          payload: { campaignId: campaign.id, ...campaignTitleNotificationPayload(campaign) },
        });
      }
    }
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
