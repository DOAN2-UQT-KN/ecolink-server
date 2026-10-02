import {
  CAMPAIGN_DAY_MAX,
  CAMPAIGN_DAY_SPAN_DAYS,
  CAMPAIGN_DESCRIPTION_MIN_LENGTH,
  CAMPAIGN_HIGH_DIFFICULTY_LEVEL,
  CAMPAIGN_HIGH_DIFFICULTY_MIN_AGE,
  CAMPAIGN_MAX_HOURS_PER_DAY,
  CAMPAIGN_MEETING_POINT_MAX,
  CAMPAIGN_MEETING_POINT_MAX_DISTANCE_KM,
  CAMPAIGN_MIN_LEAD_HOURS,
  CAMPAIGN_REPORTS_REQUIRED,
  CAMPAIGN_TITLE_MAX_LENGTH,
  CAMPAIGN_TITLE_MIN_LENGTH,
  type CampaignRequirements,
} from "@da2/constants";

/** Campaigns run in Vietnam; "same day" is judged on local (UTC+7) calendar days. */
const LOCAL_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Vietnamese phone: 0xxxxxxxxx or +84xxxxxxxxx (9 digits after the prefix). */
const VN_PHONE_RE = /^(?:\+84|0)\d{9}$/;

export interface SubmitMeetingPoint {
  name?: string | null;
  latitude: number;
  longitude: number;
  radiusKm: number;
  reportIds: string[];
}

export interface SubmitDay {
  startAt: Date;
  endAt: Date;
}

/** A shift by position; days × meeting points not listed are off. */
export interface SubmitShift {
  dayIndex: number;
  meetingPointIndex: number;
  /** Shift window; null = the day's hours. */
  startAt?: Date | null;
  endAt?: Date | null;
  gatherAt?: Date | null;
  /** Volunteers needed; 0 = the shift is off. */
  minVolunteers: number;
  /** Expected maximum; optional. */
  maxVolunteers?: number | null;
  leaderUserId?: string | null;
}

export interface SubmitCampaignInput {
  title: string;
  description: string | null;
  banner: string | null;
  /** In time order. */
  days: SubmitDay[];
  contactName: string | null;
  contactPhone: string | null;
  difficulty: number;
  requirements: CampaignRequirements | null;
  meetingPoints: SubmitMeetingPoint[];
  shifts: SubmitShift[];
  /** Why a day's minimum is below the suggestion; required only then. */
  minVolunteersReason?: string | null;
}

export interface SubmitValidationContext {
  now: Date;
  /** Minimum volunteers per day the difficulty suggests; null = no suggestion. */
  suggestedMinPerDay: number | null;
  /** Highest difficulty the organization may use (1 when unverified). */
  maxDifficulty: number | null;
  /** Reports that may be locked by this campaign (approved, and free or already its own). */
  reports: Map<string, { latitude: number | null; longitude: number | null }>;
  /** Active members of the organization allowed to lead a meeting point. */
  eligibleLeaderIds: Set<string>;
}

export interface CampaignValidationIssue {
  field: string;
  code: string;
  message: string;
}

export function stripHtml(html: string | null | undefined): string {
  return (html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, "x")
    .replace(/\s+/g, " ")
    .trim();
}

export function haversineKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) *
      Math.cos(toRad(b.latitude)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function localDayKey(date: Date): string {
  return new Date(date.getTime() + LOCAL_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** Default participation conditions: high difficulty requires adults unless set otherwise. */
export function withDefaultRequirements(
  requirements: CampaignRequirements | null,
  difficulty: number,
): CampaignRequirements {
  const base: CampaignRequirements = { ...(requirements ?? {}) };
  if (
    difficulty >= CAMPAIGN_HIGH_DIFFICULTY_LEVEL &&
    (base.minAge == null || base.minAge < CAMPAIGN_HIGH_DIFFICULTY_MIN_AGE)
  ) {
    base.minAge = CAMPAIGN_HIGH_DIFFICULTY_MIN_AGE;
  }
  return base;
}

/**
 * Every rule a campaign must satisfy to be sent for review (spec 1.2 and 1.4). Returns all
 * problems at once so the form can show them next to each field; an empty list means valid.
 */
export function validateCampaignForSubmit(
  input: SubmitCampaignInput,
  ctx: SubmitValidationContext,
): CampaignValidationIssue[] {
  const issues: CampaignValidationIssue[] = [];
  const add = (field: string, code: string, message: string) =>
    issues.push({ field, code, message });

  const title = input.title?.trim() ?? "";
  if (
    title.length < CAMPAIGN_TITLE_MIN_LENGTH ||
    title.length > CAMPAIGN_TITLE_MAX_LENGTH
  ) {
    add(
      "title",
      "TITLE_LENGTH",
      `Title must be ${CAMPAIGN_TITLE_MIN_LENGTH}–${CAMPAIGN_TITLE_MAX_LENGTH} characters`,
    );
  }
  if (stripHtml(input.description).length < CAMPAIGN_DESCRIPTION_MIN_LENGTH) {
    add(
      "description",
      "DESCRIPTION_TOO_SHORT",
      `Description must be at least ${CAMPAIGN_DESCRIPTION_MIN_LENGTH} characters`,
    );
  }
  if (!input.banner?.trim()) {
    add("banner", "BANNER_REQUIRED", "A cover image is required");
  }

  validateDays(input.days, ctx.now, add);

  if (!input.contactName?.trim()) {
    add("contactName", "CONTACT_NAME_REQUIRED", "Contact name is required");
  }
  const phone = input.contactPhone?.replace(/[\s.-]/g, "") ?? "";
  if (!VN_PHONE_RE.test(phone)) {
    add("contactPhone", "CONTACT_PHONE_INVALID", "Enter a valid phone number");
  }

  if (ctx.maxDifficulty != null && input.difficulty > ctx.maxDifficulty) {
    add(
      "difficulty",
      "DIFFICULTY_NOT_ALLOWED",
      "Unverified organizations can only create the lowest difficulty",
    );
  }

  const minAge = input.requirements?.minAge;
  if (minAge != null && (!Number.isInteger(minAge) || minAge < 0 || minAge > 100)) {
    add("requirements.minAge", "MIN_AGE_INVALID", "Minimum age must be 0–100");
  }

  validateMeetingPoints(input, ctx, add);
  validateShifts(input, ctx, add);
  return issues;
}

function validateMeetingPoints(
  input: SubmitCampaignInput,
  ctx: SubmitValidationContext,
  add: (field: string, code: string, message: string) => void,
): void {
  const points = input.meetingPoints;
  if (points.length < 1 || points.length > CAMPAIGN_MEETING_POINT_MAX) {
    add(
      "meetingPoints",
      "MEETING_POINT_COUNT",
      `A campaign needs 1–${CAMPAIGN_MEETING_POINT_MAX} meeting points`,
    );
    if (points.length === 0) return;
  }

  const seenReports = new Set<string>();
  let reportCount = 0;

  points.forEach((point, i) => {
    const at = `meetingPoints[${i}]`;
    if (points.length > 1 && !point.name?.trim()) {
      add(`${at}.name`, "MEETING_POINT_NAME_REQUIRED", "Name each meeting point");
    }
    if (!(point.radiusKm > 0)) {
      add(`${at}.radiusKm`, "RADIUS_INVALID", "Radius must be greater than 0");
    }

    for (const reportId of point.reportIds) {
      reportCount += 1;
      if (seenReports.has(reportId)) {
        add(
          `${at}.reportIds`,
          "REPORT_DUPLICATED",
          "A waste point can belong to only one meeting point",
        );
        continue;
      }
      seenReports.add(reportId);
      const report = ctx.reports.get(reportId);
      if (!report) {
        add(
          `${at}.reportIds`,
          "REPORT_UNAVAILABLE",
          `Waste point ${reportId} is not approved or already belongs to another campaign`,
        );
        continue;
      }
      if (
        report.latitude == null ||
        report.longitude == null ||
        haversineKm(point, {
          latitude: report.latitude,
          longitude: report.longitude,
        }) > point.radiusKm
      ) {
        add(
          `${at}.reportIds`,
          "REPORT_OUTSIDE_RADIUS",
          `Waste point ${reportId} is outside this meeting point's radius`,
        );
      }
    }
  });

  if (CAMPAIGN_REPORTS_REQUIRED && reportCount === 0) {
    add("meetingPoints", "REPORTS_REQUIRED", "Add at least one waste point");
  }

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (haversineKm(points[i], points[j]) > CAMPAIGN_MEETING_POINT_MAX_DISTANCE_KM) {
        add(
          `meetingPoints[${j}]`,
          "MEETING_POINTS_TOO_FAR",
          `Meeting points must be within ${CAMPAIGN_MEETING_POINT_MAX_DISTANCE_KM} km of each other; split into separate campaigns otherwise`,
        );
      }
    }
  }
}

type AddIssue = (field: string, code: string, message: string) => void;

/** Spec 1.4: 1–7 days within 14 days of the first, each on one local day, at most 12 hours. */
function validateDays(days: SubmitDay[], now: Date, add: AddIssue): void {
  if (days.length < 1 || days.length > CAMPAIGN_DAY_MAX) {
    add("days", "DAY_COUNT", `A campaign runs on 1–${CAMPAIGN_DAY_MAX} days`);
    if (days.length === 0) return;
  }
  const firstDay = Date.parse(localDayKey(days[0].startAt));
  const seen = new Set<string>();

  days.forEach((day, i) => {
    const at = `days[${i}]`;
    const key = localDayKey(day.startAt);
    if (seen.has(key)) {
      add(at, "DAY_DUPLICATED", "Each day can be added only once");
    }
    seen.add(key);
    if (Date.parse(key) - firstDay > (CAMPAIGN_DAY_SPAN_DAYS - 1) * DAY_MS) {
      add(
        at,
        "DAY_SPAN_TOO_WIDE",
        `Every day must fall within ${CAMPAIGN_DAY_SPAN_DAYS} days of the first one`,
      );
    }
    if (day.endAt.getTime() <= day.startAt.getTime()) {
      add(`${at}.endAt`, "END_BEFORE_START", "End time must be after the start time");
      return;
    }
    if (day.endAt.getTime() - day.startAt.getTime() > CAMPAIGN_MAX_HOURS_PER_DAY * HOUR_MS) {
      add(
        `${at}.endAt`,
        "TOO_LONG",
        `A campaign day lasts at most ${CAMPAIGN_MAX_HOURS_PER_DAY} hours`,
      );
    }
    if (localDayKey(day.endAt) !== key) {
      add(`${at}.endAt`, "MULTI_DAY_UNSUPPORTED", "A day must start and end on the same date");
    }
  });

  if (days[0].startAt.getTime() < now.getTime() + CAMPAIGN_MIN_LEAD_HOURS * HOUR_MS) {
    add(
      "days[0].startAt",
      "START_TOO_SOON",
      `The first day must start at least ${CAMPAIGN_MIN_LEAD_HOURS} hours from now`,
    );
  }
}

/**
 * Spec 1.4 (rev. 4): each day × meeting point is a shift with a minimum number of volunteers
 * (0 = off) and an optional expected maximum. Neither caps sign-ups; they only drive warnings.
 * An active shift needs a leader who manages the campaign and a gathering time on its day; each
 * day needs an active shift. A day whose minimum is below the difficulty's suggestion needs a
 * reason for the admin.
 */
function validateShifts(
  input: SubmitCampaignInput,
  ctx: SubmitValidationContext,
  add: AddIssue,
): void {
  const { days, meetingPoints } = input;
  if (days.length === 0 || meetingPoints.length === 0) return;
  const byCell = new Map<string, SubmitShift>();
  for (const shift of input.shifts) {
    byCell.set(`${shift.dayIndex}:${shift.meetingPointIndex}`, shift);
  }
  let belowSuggestion = false;

  days.forEach((day, d) => {
    let total = 0;
    let active = 0;
    meetingPoints.forEach((_, p) => {
      const shift = byCell.get(`${d}:${p}`);
      const at = `schedule[${d}][${p}]`;
      const min = shift?.minVolunteers ?? 0;
      if (!Number.isInteger(min) || min < 0) {
        add(
          `${at}.minVolunteers`,
          "MIN_VOLUNTEERS_INVALID",
          "Minimum volunteers must be a whole number, 0 to turn the shift off",
        );
        return;
      }
      if (min === 0 || !shift) return;
      active += 1;
      total += min;
      const max = shift.maxVolunteers;
      if (max != null && (!Number.isInteger(max) || max < min)) {
        add(
          `${at}.maxVolunteers`,
          "MAX_BELOW_MIN",
          "The expected maximum must be a whole number no lower than the minimum",
        );
      }
      if (!shift.leaderUserId || !ctx.eligibleLeaderIds.has(shift.leaderUserId)) {
        add(
          `${at}.leaderUserId`,
          "LEADER_INVALID",
          "The person in charge must be a manager of the campaign or an owner of its organization",
        );
      }
      const start = shift.startAt ?? day.startAt;
      const end = shift.endAt ?? day.endAt;
      const windowOk =
        start.getTime() < end.getTime() &&
        start.getTime() >= day.startAt.getTime() &&
        end.getTime() <= day.endAt.getTime();
      if (!windowOk) {
        add(
          `${at}.startAt`,
          "SHIFT_TIME_INVALID",
          "A shift must start before it ends, within the day's hours",
        );
      }
      if (
        shift.gatherAt &&
        // Volunteers may gather after the shift starts, but not once it is over.
        (shift.gatherAt.getTime() >= end.getTime() ||
          localDayKey(shift.gatherAt) !== localDayKey(day.startAt))
      ) {
        add(
          `${at}.gatherAt`,
          "GATHER_TIME_INVALID",
          "Gathering time must be on that day, before the shift ends",
        );
      }
    });
    if (active === 0) {
      add(`days[${d}]`, "DAY_NO_ACTIVE_SHIFT", "Each day needs at least one shift that runs");
    } else if (ctx.suggestedMinPerDay != null && total < ctx.suggestedMinPerDay) {
      belowSuggestion = true;
    }
  });

  if (belowSuggestion && !input.minVolunteersReason?.trim()) {
    add(
      "minVolunteersReason",
      "MIN_VOLUNTEERS_REASON_REQUIRED",
      `Explain why a day needs fewer than the ${ctx.suggestedMinPerDay} volunteers suggested for this difficulty`,
    );
  }
}
