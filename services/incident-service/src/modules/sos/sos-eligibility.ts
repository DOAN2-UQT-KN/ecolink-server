import {
  CampaignStatus,
  SHIFT_STATUS,
  SOS_INELIGIBLE_REASON,
  SOS_REPORTER_ROLE,
  SOS_RESIDENT_RADIUS_M,
  type SosIneligibleReasonValue,
  type SosReporterRoleValue,
} from "@da2/constants";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { campaignAccessService } from "../campaign/campaign-access.service";
import { haversineKm } from "../campaign/campaign-submit-validation";
import { localDayMonth, localHourMinute } from "../campaign/campaign_registration/staffing-shared";
import { effectiveEnd, shiftStatusOf } from "../campaign/campaign_shift_result/shift-status";
import { fetchUserVoteProfile } from "../organization/identity-user.client";
import type { SosEligibility, SosShiftOption } from "./sos.dto";

const HOUR_MS = 60 * 60 * 1000;

/** A shift can only be running while the campaign is (the lifecycle job may still lag on UPCOMING). */
const RAISABLE_CAMPAIGN_STATUSES: number[] = [CampaignStatus.UPCOMING, CampaignStatus.ACTIVE];

export type RunningShift = Awaited<ReturnType<typeof runningShifts>>[number];

const pointName = (p: { name: string | null; sortOrder: number }) => p.name || `#${p.sortOrder + 1}`;

/** "Point dd/MM HH:mm–HH:mm" (local time). */
export const sosShiftName = (s: {
  startAt: Date;
  endAt: Date;
  endedAt?: Date | null;
  meetingPoint: { name: string | null; sortOrder: number };
}) =>
  `${pointName(s.meetingPoint)} ${localDayMonth(s.startAt)} ${localHourMinute(s.startAt)}–${localHourMinute(effectiveEnd(s))}`;

export const toShiftOption = (s: RunningShift): SosShiftOption => ({
  id: s.id,
  name: sosShiftName(s),
  meetingPointId: s.meetingPointId,
  meetingPointName: s.meetingPoint.name,
  startAt: s.startAt,
  endAt: effectiveEnd(s),
});

/** The campaign's shifts running at `now` (spec 4.2 status), with their meeting point. */
export async function runningShifts(campaignId: string, now: Date) {
  const shifts = await prisma.campaignShift.findMany({
    where: { campaignId, startAt: { lte: now }, minVolunteers: { gt: 0 } },
    include: { meetingPoint: true, result: { select: { reopenedAt: true } } },
    orderBy: { startAt: "asc" },
  });
  return shifts.filter(
    (s) => s.meetingPoint.deletedAt == null && shiftStatusOf(s, s.result, now) === SHIFT_STATUS.RUNNING,
  );
}

/**
 * SOS one person may raise per rolling hour; 0 (default) = no limit. The spec value is
 * `SOS_MAX_PER_HOUR` (3); the limit is off for now and comes back with SOS_MAX_PER_HOUR=3.
 */
export function sosHourlyLimit(): number {
  const n = Number(process.env.SOS_MAX_PER_HOUR ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** SOS the user may still raise in the rolling hour; null when there is no limit. */
export async function hourlyRemaining(userId: string, now: Date): Promise<number | null> {
  const limit = sosHourlyLimit();
  if (limit === 0) return null;
  const used = await prisma.sos.count({
    where: { createdBy: userId, deletedAt: null, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
  });
  return Math.max(0, limit - used);
}

export interface EligibilityResult extends SosEligibility {
  /** The running shifts behind `shifts`, for the create flow. */
  running: RunningShift[];
  /** Resident: the profile's phone and verified email are already known. */
  phone?: string | null;
}

/**
 * Who may raise an SOS for a campaign (spec "Ai được phát SOS"), in this order:
 *   - manager: may manage the campaign; any running shift
 *   - leader: leads a running shift
 *   - volunteer: checked in on a running shift, not checked out, not excluded
 *   - resident: verified email, a phone in the profile, GPS within 500 m of a meeting point with a
 *     running shift; the nearest one
 * Deviation from the spec: a verified email and a phone on the profile stand in for a verified phone.
 */
export async function resolveSosEligibility(
  campaignId: string,
  userId: string | null | undefined,
  location: { latitude?: number; longitude?: number },
  now = new Date(),
): Promise<EligibilityResult> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, deletedAt: null },
    select: { id: true, organizationId: true, createdBy: true, status: true },
  });
  if (!campaign) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"));

  const no = (
    reason: SosIneligibleReasonValue,
    remaining: number | null,
    running: RunningShift[] = [],
  ): EligibilityResult => ({
    canRaise: false,
    role: null,
    reason,
    shifts: [],
    hourlyRemaining: remaining,
    running,
  });
  if (!userId) return no(SOS_INELIGIBLE_REASON.NOT_LOGGED, 0);
  const remaining = await hourlyRemaining(userId, now);

  const running = RAISABLE_CAMPAIGN_STATUSES.includes(campaign.status)
    ? await runningShifts(campaignId, now)
    : [];
  if (running.length === 0) return no(SOS_INELIGIBLE_REASON.NO_RUNNING_SHIFT, remaining);

  const yes = (role: SosReporterRoleValue, shifts: RunningShift[], phone?: string | null): EligibilityResult => ({
    canRaise: true,
    role,
    reason: null,
    shifts: shifts.map(toShiftOption),
    hourlyRemaining: remaining,
    running: shifts,
    ...(phone !== undefined ? { phone } : {}),
  });

  if (await campaignAccessService.canManage(campaign, userId)) {
    return yes(SOS_REPORTER_ROLE.MANAGER, running);
  }
  const led = running.filter((s) => s.leaderUserId === userId);
  if (led.length > 0) return yes(SOS_REPORTER_ROLE.LEADER, led);

  const attended = await prisma.campaignShiftAttendance.findMany({
    where: {
      userId,
      shiftId: { in: running.map((s) => s.id) },
      checkOutAt: null,
      excludedAt: null,
    },
    select: { shiftId: true },
  });
  if (attended.length > 0) {
    const ids = new Set(attended.map((a) => a.shiftId));
    return yes(SOS_REPORTER_ROLE.VOLUNTEER, running.filter((s) => ids.has(s.id)));
  }

  // Resident: the nearest meeting point with a running shift, within 500 m.
  const { latitude, longitude } = location;
  if (latitude == null || longitude == null) {
    return no(SOS_INELIGIBLE_REASON.LOCATION_REQUIRED, remaining);
  }
  const nearest = running
    .map((s) => ({ s, m: haversineKm({ latitude, longitude }, s.meetingPoint) * 1000 }))
    .sort((a, b) => a.m - b.m)[0];
  if (nearest.m > SOS_RESIDENT_RADIUS_M) return no(SOS_INELIGIBLE_REASON.TOO_FAR, remaining);

  const profile = await fetchUserVoteProfile({ userId, latitude, longitude });
  if (!profile?.emailVerified) return no(SOS_INELIGIBLE_REASON.EMAIL_UNVERIFIED, remaining);
  if (!profile.phoneNumber) return no(SOS_INELIGIBLE_REASON.PHONE_MISSING, remaining);
  return yes(SOS_REPORTER_ROLE.RESIDENT, [nearest.s], profile.phoneNumber);
}
