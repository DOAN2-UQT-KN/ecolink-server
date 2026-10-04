import { Prisma } from "@prisma/client";
import {
  CAMPAIGN_DAY_MAX,
  CAMPAIGN_MEETING_POINT_MAX,
  CAMPAIGN_MIN_LEAD_HOURS,
  CampaignStatus,
  type CampaignRequirements,
} from "@da2/constants";
import prisma from "../../config/prisma.client";
import { ReportStatus } from "../../constants/status.enum";
import { HttpError, HTTP_STATUS } from "../../constants/http-status";
import { emitOutbox } from "../../outbox/outbox.writer";
import { OutboxEventType } from "../../outbox/outbox.types";
import { rewardServiceClient } from "../reward/reward-service.client";
import { findTeamIds, assertLeadersInTeam } from "./campaign_manager/campaign-team";
import { campaignEligibilityService } from "./campaign-eligibility.service";
import { campaignTitleNotificationPayload } from "./campaign-i18n";
import {
  campaignLifecycleService,
  diffSnapshots,
  normalizeMeetingPoints,
  type NormalizedMeetingPoint,
  type NormalizedSchedule,
  type NormalizedShift,
} from "./campaign-lifecycle.service";
import { logCampaignEdit, transitionCampaign } from "./campaign-state-machine";
import {
  validateCampaignForSubmit,
  withDefaultRequirements,
} from "./campaign-submit-validation";
import type { UpdateCampaignRequest } from "./campaign.dto";
import type { CampaignWithReports } from "./campaign.entity";
import { localDayMonth, localHourMinute } from "./campaign_registration/staffing-shared";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Statuses an approved campaign may be edited in (spec 3.5): upcoming, or back under review after
 * an earlier edit. Once it runs, nothing changes through editing.
 */
export const POST_APPROVAL_EDITABLE_STATUSES: readonly number[] = [
  CampaignStatus.UPCOMING,
  CampaignStatus.PENDING_REVIEW,
  CampaignStatus.NEEDS_REVISION,
];

/** Edits of this campaign go through `applyPostApprovalEdit` (ids and registrations kept). */
export function isPostApprovalEdit(campaign: { approvedAt: Date | null; status: number }): boolean {
  return campaign.approvedAt != null && POST_APPROVAL_EDITABLE_STATUSES.includes(campaign.status);
}

const invalid = (message: string) =>
  new HttpError(HTTP_STATUS.VALIDATION_ERROR.withMessage(message));

const textOf = (value: string | null | undefined) => value?.trim() || null;

/** Fields saved at once, with a log, whatever the status (spec 3.5 "Tự do"). */
const FREE_FIELDS = [
  "title",
  "description",
  "banner",
  "contactName",
  "contactPhone",
  "safetyNotes",
  "minVolunteersReason",
] as const;

type Day = NonNullable<CampaignWithReports["days"]>[number];
type Point = NonNullable<CampaignWithReports["meetingPoints"]>[number];
type Shift = NonNullable<CampaignWithReports["shifts"]>[number];

interface PlannedDay {
  existing: Day | null;
  startAt: Date;
  endAt: Date;
  /** An existing day given new times. */
  moved: boolean;
}

interface PlannedPoint {
  existing: Point | null;
  value: NormalizedMeetingPoint;
}

interface PlannedShift {
  existing: Shift | null;
  /** Indexes into the planned days (time order) and points. */
  dayIndex: number;
  meetingPointIndex: number;
  startAt: Date;
  endAt: Date;
  gatherAt: Date | null;
  minVolunteers: number;
  maxVolunteers: number | null;
  leaderUserId: string | null;
}

const sameMs = (a: Date | null | undefined, b: Date | null | undefined) =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

const stable = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

const pointValue = (p: Point): NormalizedMeetingPoint => ({
  name: p.name,
  latitude: p.latitude,
  longitude: p.longitude,
  detailAddress: p.detailAddress,
  radiusKm: p.radiusKm,
  reportIds: p.reports.map((r: { reportId: string }) => r.reportId).sort(),
});

const samePoint = (a: NormalizedMeetingPoint, b: NormalizedMeetingPoint) =>
  stable({ ...a, reportIds: [...a.reportIds].sort() }) ===
  stable({ ...b, reportIds: [...b.reportIds].sort() });

/** A day's new times: valid, and at least the creation lead time from now. */
function timesOf(d: { startAt: string; endAt: string }, now: Date): { startAt: Date; endAt: Date } {
  const startAt = new Date(d.startAt);
  const endAt = new Date(d.endAt);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    throw invalid("Every day needs a valid start and end time");
  }
  if (startAt.getTime() < now.getTime() + CAMPAIGN_MIN_LEAD_HOURS * HOUR_MS) {
    throw new HttpError(HTTP_STATUS.CAMPAIGN_INVALID, {
      details: [
        {
          field: "days",
          code: "START_TOO_SOON",
          message: `A new or moved day must start at least ${CAMPAIGN_MIN_LEAD_HOURS} hours from now`,
        },
      ],
    });
  }
  return { startAt, endAt };
}

/** What a request changes, sorted into the groups of spec 3.5. */
export interface EditPlan {
  free: Partial<Record<(typeof FREE_FIELDS)[number], string | null>>;
  difficulty?: number;
  requirements?: CampaignRequirements | null;
  days: PlannedDay[];
  points: PlannedPoint[];
  shifts: PlannedShift[];
  removedDays: Day[];
  removedPoints: Point[];
  /** Existing shifts that go away with a removed day or meeting point. */
  removedShifts: Shift[];
  /** Shift numbers or leaders changed on existing shifts. */
  numbersChanged: boolean;
  /** Something that sends the campaign back to review changed. */
  major: boolean;
  scheduleTouched: boolean;
}

/**
 * Sorts a request into free fields, shift numbers and important fields (spec 3.5), matching
 * days and meeting points by id. New times for an existing day or shift are an important change;
 * like a new day, they start at least the lead time from now, and only before they start.
 */
export function planPostApprovalEdit(
  existing: CampaignWithReports,
  request: UpdateCampaignRequest,
  now: Date,
): EditPlan {
  const free: EditPlan["free"] = {};
  for (const key of FREE_FIELDS) {
    if (request[key] === undefined) continue;
    const next = key === "title" ? (request.title ?? "").trim() : textOf(request[key]);
    const current = existing[key] ?? null;
    if (next !== current) free[key] = next;
  }
  if (free.title !== undefined && !free.title) throw invalid("Title is required");

  let major = false;
  let difficulty: number | undefined;
  if (request.difficulty !== undefined && request.difficulty !== existing.difficulty) {
    difficulty = request.difficulty;
    major = true;
  }
  let requirements: CampaignRequirements | null | undefined;
  if (request.requirements !== undefined) {
    const next = (request.requirements ?? null) as CampaignRequirements | null;
    if (stable(next) !== stable(existing.requirements ?? null)) {
      requirements = next;
      major = true;
    }
  }

  // A client that does not send ids (older app versions) would otherwise drop every day or
  // meeting point and their registrations with them.
  if (
    (request.days !== undefined && (existing.days ?? []).length > 0 && !request.days.some((d) => d.id)) ||
    (request.meetingPoints !== undefined &&
      (existing.meetingPoints ?? []).length > 0 &&
      !request.meetingPoints.some((p) => p.id))
  ) {
    throw invalid("Days and meeting points of an approved campaign are matched by id; send their ids");
  }

  const existingDays = [...(existing.days ?? [])].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const existingPoints = [...(existing.meetingPoints ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const scheduleTouched =
    request.days !== undefined || request.meetingPoints !== undefined || request.shifts !== undefined;

  // Days, in the order the request lists them (shift dayIndex points into this order).
  const dayById = new Map(existingDays.map((d) => [d.id, d]));
  const requestDays: PlannedDay[] = (request.days ?? existingDays.map((d) => ({ id: d.id, startAt: "", endAt: "" }))).map(
    (d) => {
      if (d.id) {
        const day = dayById.get(d.id);
        if (!day) throw invalid("A day does not belong to this campaign");
        if (
          request.days === undefined ||
          (sameMs(new Date(d.startAt), day.startAt) && sameMs(new Date(d.endAt), day.endAt))
        ) {
          return { existing: day, startAt: day.startAt, endAt: day.endAt, moved: false };
        }
        if (day.startAt.getTime() <= now.getTime()) {
          throw new HttpError(HTTP_STATUS.SHIFT_ALREADY_STARTED.withMessage("This day has already started"));
        }
        const { startAt, endAt } = timesOf(d, now);
        major = true;
        return { existing: day, startAt, endAt, moved: true };
      }
      const { startAt, endAt } = timesOf(d, now);
      return { existing: null, startAt, endAt, moved: false };
    },
  );
  if (new Set(requestDays.filter((d) => d.existing).map((d) => d.existing!.id)).size !==
    requestDays.filter((d) => d.existing).length) {
    throw invalid("A day is listed twice");
  }
  if (requestDays.length > CAMPAIGN_DAY_MAX) throw invalid(`At most ${CAMPAIGN_DAY_MAX} days`);
  const keptDayIds = new Set(requestDays.filter((d) => d.existing).map((d) => d.existing!.id));
  const removedDays = existingDays.filter((d) => !keptDayIds.has(d.id));
  // Time order; remember where each request index went.
  const dayOrder = requestDays
    .map((day, index) => ({ day, index }))
    .sort((a, b) => a.day.startAt.getTime() - b.day.startAt.getTime());
  const dayIndexOf = new Map(dayOrder.map((o, i) => [o.index, i]));
  const days = dayOrder.map((o) => o.day);
  if (removedDays.length > 0 || days.some((d) => !d.existing)) major = true;

  // Meeting points, in the order the request lists them.
  const pointById = new Map(existingPoints.map((p) => [p.id, p]));
  const pointInputs = request.meetingPoints;
  const points: PlannedPoint[] = pointInputs
    ? pointInputs.map((input) => {
        const [value] = normalizeMeetingPoints([input]);
        if (input.id) {
          const point = pointById.get(input.id);
          if (!point) throw invalid("A meeting point does not belong to this campaign");
          if (!samePoint(pointValue(point), value)) major = true;
          return { existing: point, value };
        }
        major = true;
        return { existing: null, value };
      })
    : existingPoints.map((p) => ({ existing: p, value: pointValue(p) }));
  if (points.length > CAMPAIGN_MEETING_POINT_MAX) {
    throw invalid(`At most ${CAMPAIGN_MEETING_POINT_MAX} meeting points`);
  }
  const keptPointIds = new Set(points.filter((p) => p.existing).map((p) => p.existing!.id));
  if (keptPointIds.size !== points.filter((p) => p.existing).length) {
    throw invalid("A meeting point is listed twice");
  }
  const removedPoints = existingPoints.filter((p) => !keptPointIds.has(p.id));
  if (removedPoints.length > 0) major = true;
  // A point keeps its position as listed; existing ones not listed keep theirs.
  if (
    pointInputs &&
    points.some((p, i) => p.existing && existingPoints.indexOf(p.existing) !== i)
  ) {
    major = true;
  }

  const existingShifts = existing.shifts ?? [];
  const shiftByCell = new Map(existingShifts.map((s) => [`${s.dayId}:${s.meetingPointId}`, s]));
  const removedShifts = existingShifts.filter(
    (s) => !keptDayIds.has(s.dayId) || !keptPointIds.has(s.meetingPointId),
  );

  const requested = new Map<string, NonNullable<UpdateCampaignRequest["shifts"]>[number]>();
  for (const sh of request.shifts ?? []) {
    const d = dayIndexOf.get(Number(sh.dayIndex));
    const p = Number(sh.meetingPointIndex);
    if (d === undefined || !Number.isInteger(p) || p < 0 || p >= points.length) {
      throw invalid("A shift points to a missing day or meeting point");
    }
    const key = `${d}:${p}`;
    if (requested.has(key)) throw invalid("Each day × meeting point can have only one shift");
    requested.set(key, sh);
  }

  let numbersChanged = false;
  const shifts: PlannedShift[] = [];
  days.forEach((day, d) =>
    points.forEach((point, p) => {
      const current =
        day.existing && point.existing
          ? shiftByCell.get(`${day.existing.id}:${point.existing.id}`) ?? null
          : null;
      const asked = requested.get(`${d}:${p}`);
      if (current) {
        if (!asked) {
          shifts.push({
            existing: current,
            dayIndex: d,
            meetingPointIndex: p,
            startAt: current.startAt,
            endAt: current.endAt,
            gatherAt: current.gatherAt,
            minVolunteers: current.minVolunteers,
            maxVolunteers: current.maxVolunteers,
            leaderUserId: current.leaderUserId,
          });
          return;
        }
        const start = asked.startAt ? new Date(asked.startAt) : day.startAt;
        const end = asked.endAt ? new Date(asked.endAt) : day.endAt;
        const gather = asked.gatherAt ? new Date(asked.gatherAt) : null;
        const timesChanged =
          !sameMs(start, current.startAt) || !sameMs(end, current.endAt) || !sameMs(gather, current.gatherAt);
        if (timesChanged) {
          if (current.startAt.getTime() <= now.getTime()) {
            throw new HttpError(HTTP_STATUS.SHIFT_ALREADY_STARTED);
          }
          major = true;
        }
        const min = Number(asked.minVolunteers ?? 0);
        const max = asked.maxVolunteers == null ? null : Number(asked.maxVolunteers);
        const leader = asked.leaderUserId?.trim() || null;
        if (current.minVolunteers > 0 && min === 0) {
          throw new HttpError(HTTP_STATUS.SHIFT_MIN_REQUIRED);
        }
        if (min !== current.minVolunteers || max !== current.maxVolunteers || leader !== current.leaderUserId) {
          numbersChanged = true;
        }
        shifts.push({
          existing: current,
          dayIndex: d,
          meetingPointIndex: p,
          startAt: current.startAt,
          endAt: current.endAt,
          gatherAt: current.gatherAt,
          ...(timesChanged ? { startAt: start, endAt: end, gatherAt: gather } : {}),
          minVolunteers: min,
          maxVolunteers: max,
          leaderUserId: leader,
        });
        return;
      }
      // A new day or meeting point brings new shifts, off unless asked for.
      shifts.push({
        existing: null,
        dayIndex: d,
        meetingPointIndex: p,
        startAt: asked?.startAt ? new Date(asked.startAt) : day.startAt,
        endAt: asked?.endAt ? new Date(asked.endAt) : day.endAt,
        gatherAt: asked?.gatherAt ? new Date(asked.gatherAt) : null,
        minVolunteers: Number(asked?.minVolunteers ?? 0),
        maxVolunteers: asked?.maxVolunteers == null ? null : Number(asked.maxVolunteers),
        leaderUserId: asked?.leaderUserId?.trim() || existing.createdBy,
      });
    }),
  );
  for (const sh of shifts) {
    if (
      [sh.startAt, sh.endAt, sh.gatherAt].some((t) => t != null && Number.isNaN(t.getTime()))
    ) {
      throw invalid("Shift times must be valid dates");
    }
  }

  return {
    free,
    difficulty,
    requirements,
    days,
    points,
    shifts,
    removedDays,
    removedPoints,
    removedShifts,
    numbersChanged,
    major,
    scheduleTouched,
  };
}

/** The planned schedule in the shape the submit rules read. */
function toNormalizedSchedule(plan: EditPlan): NormalizedSchedule {
  return {
    days: plan.days.map((d) => ({ startAt: d.startAt, endAt: d.endAt })),
    meetingPoints: plan.points.map((p) => p.value),
    shifts: plan.shifts.map(
      (sh): NormalizedShift => ({
        dayIndex: sh.dayIndex,
        meetingPointIndex: sh.meetingPointIndex,
        startAt: sameMs(sh.startAt, plan.days[sh.dayIndex].startAt) ? null : sh.startAt,
        endAt: sameMs(sh.endAt, plan.days[sh.dayIndex].endAt) ? null : sh.endAt,
        gatherAt: sh.gatherAt,
        minVolunteers: sh.minVolunteers,
        maxVolunteers: sh.maxVolunteers,
        leaderUserId: sh.leaderUserId,
      }),
    ),
  };
}

/**
 * Runs the submit rules on the edited campaign. The first day's lead time only counts when the
 * first day is new: an existing day may well be close by now.
 */
async function assertEditedCampaignValid(
  existing: CampaignWithReports,
  plan: EditPlan,
  userId: string,
  now: Date,
): Promise<void> {
  const difficulty = plan.difficulty ?? existing.difficulty;
  const tier = await rewardServiceClient.getDifficultyByLevelStrict(difficulty);
  if (!tier) {
    throw new HttpError(HTTP_STATUS.CAMPAIGN_INVALID, {
      details: [
        { field: "difficulty", code: "DIFFICULTY_UNKNOWN", message: `Difficulty level ${difficulty} does not exist` },
      ],
    });
  }
  const eligibility = await campaignEligibilityService.get(userId, existing.organizationId, {
    excludeCampaignId: existing.id,
  });
  const schedule = toNormalizedSchedule(plan);
  const reportIds = schedule.meetingPoints.flatMap((p) => p.reportIds);
  const leaderIds = [
    ...new Set(
      schedule.shifts
        .filter((sh) => sh.minVolunteers > 0)
        .map((sh) => sh.leaderUserId)
        .filter((x): x is string => !!x),
    ),
  ];
  const [reports, leaders] = await Promise.all([
    prisma.report.findMany({
      where: {
        id: { in: reportIds },
        deletedAt: null,
        OR: [
          { campaignId: null, status: ReportStatus._STATUS_TODO },
          { campaignId: existing.id },
        ],
      },
      select: { id: true, latitude: true, longitude: true },
    }),
    findTeamIds(prisma, existing, leaderIds),
  ]);
  const requirements = withDefaultRequirements(
    plan.requirements !== undefined
      ? plan.requirements
      : ((existing.requirements as CampaignRequirements | null) ?? null),
    difficulty,
  );
  const value = <K extends (typeof FREE_FIELDS)[number]>(key: K) =>
    plan.free[key] !== undefined ? plan.free[key] : (existing[key] ?? null);
  // A new or moved first day must keep the lead time; an untouched one may well be close by now.
  const firstDayIsNew = plan.days[0] && (!plan.days[0].existing || plan.days[0].moved);
  const issues = validateCampaignForSubmit(
    {
      title: value("title") ?? "",
      description: value("description"),
      banner: value("banner"),
      days: schedule.days,
      contactName: value("contactName"),
      contactPhone: value("contactPhone"),
      difficulty,
      requirements,
      meetingPoints: schedule.meetingPoints,
      shifts: schedule.shifts,
      minVolunteersReason: value("minVolunteersReason"),
    },
    {
      now,
      suggestedMinPerDay: tier.suggestedMinVolunteers,
      maxDifficulty: eligibility.maxDifficulty,
      reports: new Map(reports.map((r) => [r.id, r])),
      eligibleLeaderIds: leaders,
    },
  ).filter((issue) => issue.code !== "START_TOO_SOON" || firstDayIsNew);
  if (issues.length > 0) {
    throw new HttpError(HTTP_STATUS.CAMPAIGN_INVALID, { details: issues });
  }
}

const shiftLabel = (point: { name: string | null; sortOrder: number }, startAt: Date) =>
  `${point.name || `#${point.sortOrder + 1}`} ${localHourMinute(startAt)}`;

/**
 * Spec 3.5 for an approved campaign: free fields and shift numbers are saved at once with a log;
 * an important change also sends an upcoming campaign back to review, and every volunteer is
 * told. Days, meeting points and shifts are updated in place by id, so registrations stay;
 * the shifts of a removed day or meeting point go away with their registrations, and their
 * volunteers are told. Returns whether the campaign is (back) under review because of it.
 */
export async function applyPostApprovalEdit(
  existing: CampaignWithReports,
  userId: string,
  request: UpdateCampaignRequest,
  now = new Date(),
): Promise<{ reReview: boolean }> {
  const plan = planPostApprovalEdit(existing, request, now);
  const leaderChanges = plan.shifts
    .filter((sh) => sh.leaderUserId && sh.leaderUserId !== (sh.existing?.leaderUserId ?? null))
    .map((sh) => sh.leaderUserId as string);
  await assertLeadersInTeam(prisma, existing, leaderChanges);
  if (plan.major || plan.numbersChanged || plan.free.title !== undefined || plan.free.description !== undefined) {
    await assertEditedCampaignValid(existing, plan, userId, now);
  }

  const result = await prisma.$transaction(
    async (tx) => {
      const before = await campaignLifecycleService.loadInTx(tx, existing.id);
      if (before.status !== existing.status) {
        throw new HttpError(
          HTTP_STATUS.CAMPAIGN_INVALID_TRANSITION.withMessage(
            "The campaign changed meanwhile; reload and try again",
          ),
        );
      }

      await tx.campaign.update({
        where: { id: existing.id },
        data: {
          ...plan.free,
          title: plan.free.title ?? undefined,
          ...(plan.difficulty !== undefined ? { difficulty: plan.difficulty } : {}),
          ...(plan.requirements !== undefined
            ? {
                requirements:
                  plan.requirements === null
                    ? Prisma.DbNull
                    : (plan.requirements as Prisma.InputJsonValue),
              }
            : {}),
          updatedBy: userId,
        },
      });

      // Shifts that go away: their volunteers are told, then the rows are removed.
      const removedShiftIds = plan.removedShifts.map((s) => s.id);
      const removedNotices: Array<{ userIds: string[]; shift: Shift }> = [];
      if (removedShiftIds.length > 0) {
        const live = await tx.campaignShiftRegistration.findMany({
          where: { shiftId: { in: removedShiftIds }, leftAt: null },
          select: { shiftId: true, userId: true },
        });
        for (const shift of plan.removedShifts) {
          const userIds = [...new Set(live.filter((r) => r.shiftId === shift.id).map((r) => r.userId))];
          if (userIds.length > 0) removedNotices.push({ userIds, shift });
        }
        await tx.campaignShiftRegistration.deleteMany({ where: { shiftId: { in: removedShiftIds } } });
        await tx.campaignShift.deleteMany({ where: { id: { in: removedShiftIds } } });
      }
      if (plan.removedDays.length > 0) {
        await tx.campaignDay.deleteMany({ where: { id: { in: plan.removedDays.map((d) => d.id) } } });
      }
      if (plan.removedPoints.length > 0) {
        const ids = plan.removedPoints.map((p) => p.id);
        await tx.campaignMeetingPointReport.deleteMany({ where: { meetingPointId: { in: ids } } });
        await tx.campaignMeetingPoint.updateMany({
          where: { id: { in: ids } },
          data: { deletedAt: now, updatedBy: userId },
        });
      }

      // Days and meeting points, in place; new ones created.
      const dayIds: string[] = [];
      for (const [index, day] of plan.days.entries()) {
        if (day.existing) {
          await tx.campaignDay.update({
            where: { id: day.existing.id },
            data: {
              sortOrder: index,
              ...(day.moved
                ? { startAt: day.startAt, endAt: day.endAt, understaffedNotifiedAt: null }
                : {}),
            },
          });
          dayIds.push(day.existing.id);
        } else {
          const created = await tx.campaignDay.create({
            data: { campaignId: existing.id, startAt: day.startAt, endAt: day.endAt, sortOrder: index },
          });
          dayIds.push(created.id);
        }
      }
      // A waste point may move between meeting points (unique per campaign): drop the old links
      // of every changed point before creating any.
      const relinked = plan.points.filter(
        (p) =>
          p.existing &&
          stable([...p.value.reportIds].sort()) !== stable(pointValue(p.existing).reportIds),
      );
      if (relinked.length > 0) {
        await tx.campaignMeetingPointReport.deleteMany({
          where: { meetingPointId: { in: relinked.map((p) => p.existing!.id) } },
        });
      }
      const pointIds: string[] = [];
      for (const [index, point] of plan.points.entries()) {
        const data = {
          name: point.value.name,
          latitude: point.value.latitude,
          longitude: point.value.longitude,
          detailAddress: point.value.detailAddress,
          radiusKm: point.value.radiusKm,
          sortOrder: index,
          updatedBy: userId,
        };
        let id: string;
        if (point.existing) {
          id = point.existing.id;
          await tx.campaignMeetingPoint.update({ where: { id }, data });
          if (relinked.includes(point)) {
            if (point.value.reportIds.length > 0) {
              await tx.campaignMeetingPointReport.createMany({
                data: point.value.reportIds.map((reportId) => ({
                  meetingPointId: id,
                  reportId,
                  campaignId: existing.id,
                })),
              });
            }
          }
        } else {
          const created = await tx.campaignMeetingPoint.create({
            data: { ...data, campaignId: existing.id, createdBy: userId },
          });
          id = created.id;
          if (point.value.reportIds.length > 0) {
            await tx.campaignMeetingPointReport.createMany({
              data: point.value.reportIds.map((reportId) => ({
                meetingPointId: id,
                reportId,
                campaignId: existing.id,
              })),
            });
          }
        }
        pointIds.push(id);
      }

      // Shifts: numbers and leaders in place, new cells created.
      for (const sh of plan.shifts) {
        if (sh.existing) {
          const e = sh.existing;
          const timesChanged =
            !sameMs(sh.startAt, e.startAt) || !sameMs(sh.endAt, e.endAt) || !sameMs(sh.gatherAt, e.gatherAt);
          if (
            timesChanged ||
            sh.minVolunteers !== e.minVolunteers ||
            sh.maxVolunteers !== e.maxVolunteers ||
            sh.leaderUserId !== e.leaderUserId
          ) {
            await tx.campaignShift.update({
              where: { id: e.id },
              data: {
                ...(timesChanged ? { startAt: sh.startAt, endAt: sh.endAt, gatherAt: sh.gatherAt } : {}),
                minVolunteers: sh.minVolunteers,
                maxVolunteers: sh.maxVolunteers,
                leaderUserId: sh.leaderUserId,
                ...(sh.maxVolunteers !== e.maxVolunteers ? { overMaxNotifiedAt: null } : {}),
              },
            });
          }
          continue;
        }
        await tx.campaignShift.create({
          data: {
            campaignId: existing.id,
            dayId: dayIds[sh.dayIndex],
            meetingPointId: pointIds[sh.meetingPointIndex],
            startAt: sh.startAt,
            endAt: sh.endAt,
            gatherAt: sh.gatherAt,
            minVolunteers: sh.minVolunteers,
            maxVolunteers: sh.maxVolunteers,
            leaderUserId: sh.leaderUserId,
          },
        });
      }

      // New times: the days concerned are reminded again at their new gathering time (3.7).
      const retimedDayIds = new Set([
        ...plan.days.filter((d) => d.moved && d.existing).map((d) => d.existing!.id),
        ...plan.shifts
          .filter(
            (sh) =>
              sh.existing &&
              (!sameMs(sh.startAt, sh.existing.startAt) ||
                !sameMs(sh.endAt, sh.existing.endAt) ||
                !sameMs(sh.gatherAt, sh.existing.gatherAt)),
          )
          .map((sh) => sh.existing!.dayId),
      ]);
      if (retimedDayIds.size > 0) {
        await tx.campaignShiftRegistration.updateMany({
          where: { leftAt: null, shift: { dayId: { in: [...retimedDayIds] } } },
          data: { reminded24hAt: null, reminded1hAt: null },
        });
      }

      if (plan.scheduleTouched) {
        const first = plan.points[0]?.value;
        if (first) {
          await tx.campaign.update({
            where: { id: existing.id },
            data: {
              latitude: first.latitude,
              longitude: first.longitude,
              radiusKm: first.radiusKm,
              detailAddress: first.detailAddress,
            },
          });
        }
        await campaignLifecycleService.syncReportLocks(tx, existing.id, userId);
      }

      const after = await campaignLifecycleService.loadInTx(tx, existing.id);
      const changes = diffSnapshots(
        campaignLifecycleService.snapshotOf(before),
        campaignLifecycleService.snapshotOf(after),
      );
      if (Object.keys(changes).length === 0) return { reReview: false, after };

      const toReview = plan.major && before.status === CampaignStatus.UPCOMING;
      if (toReview) {
        await transitionCampaign(tx, {
          campaignId: existing.id,
          event: "edit_major",
          fromStatus: before.status,
          actor: "manager",
          actorId: userId,
          changes: changes as Prisma.InputJsonValue,
          data: {
            submittedAt: now,
            lastSubmittedSnapshot: campaignLifecycleService.snapshotOf(after) as unknown as Prisma.InputJsonValue,
          },
        });
      } else {
        await logCampaignEdit(tx, {
          campaignId: existing.id,
          status: before.status,
          actorId: userId,
          changes,
        });
      }

      const titles = campaignTitleNotificationPayload(after);
      const stamp = now.getTime();
      for (const notice of removedNotices) {
        await emitOutbox(tx, {
          aggregateType: "campaign",
          aggregateId: existing.id,
          eventType: OutboxEventType.WEBSITE_NOTIFICATION,
          dedupKey: `CAMPAIGN_SHIFT_CLOSED:${notice.shift.id}:edit:${stamp}`,
          payload: {
            kind: "CAMPAIGN_SHIFT_CLOSED",
            userIds: notice.userIds,
            payload: {
              campaignId: existing.id,
              day: localDayMonth(notice.shift.startAt),
              shift: shiftLabel(
                (before.meetingPoints ?? []).find((p) => p.id === notice.shift.meetingPointId) ??
                  { name: null, sortOrder: 0 },
                notice.shift.startAt,
              ),
              ...titles,
            },
          },
        });
      }
      if (plan.major) {
        const volunteers = await tx.campaignShiftRegistration.findMany({
          where: { campaignId: existing.id, leftAt: null },
          distinct: ["userId"],
          select: { userId: true },
        });
        if (volunteers.length > 0) {
          await emitOutbox(tx, {
            aggregateType: "campaign",
            aggregateId: existing.id,
            eventType: OutboxEventType.WEBSITE_NOTIFICATION,
            dedupKey: `CAMPAIGN_UPDATED_NEEDS_REVIEW:${existing.id}:${stamp}`,
            payload: {
              kind: "CAMPAIGN_UPDATED_NEEDS_REVIEW",
              userIds: volunteers.map((v) => v.userId),
              payload: {
                campaignId: existing.id,
                underReview: toReview || before.status !== CampaignStatus.UPCOMING ? "1" : "",
                ...titles,
              },
            },
          });
        }
      }
      return { reReview: toReview, after };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  if (result.reReview) {
    void campaignLifecycleService
      .notifyReReview(result.after)
      .catch((err) => console.warn("[campaign] failed to tell admins about a re-review", err));
  }
  return { reReview: result.reReview };
}
