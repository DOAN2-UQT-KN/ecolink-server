import {
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
/** Vietnamese phone: 0xxxxxxxxx or +84xxxxxxxxx (9 digits after the prefix). */
const VN_PHONE_RE = /^(?:\+84|0)\d{9}$/;

export interface SubmitMeetingPoint {
  name?: string | null;
  latitude: number;
  longitude: number;
  radiusKm: number;
  gatherAt?: Date | null;
  slots?: number | null;
  leaderUserId?: string | null;
  reportIds: string[];
}

export interface SubmitCampaignInput {
  title: string;
  description: string | null;
  banner: string | null;
  startDate: Date | null;
  endDate: Date | null;
  contactName: string | null;
  contactPhone: string | null;
  difficulty: number;
  requirements: CampaignRequirements | null;
  meetingPoints: SubmitMeetingPoint[];
}

export interface SubmitValidationContext {
  now: Date;
  /** Volunteer cap of the difficulty tier; null = no cap. */
  maxVolunteers: number | null;
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

  const { startDate, endDate } = input;
  if (!startDate) add("startDate", "START_REQUIRED", "Start time is required");
  if (!endDate) add("endDate", "END_REQUIRED", "End time is required");
  if (startDate && endDate) {
    if (startDate.getTime() < ctx.now.getTime() + CAMPAIGN_MIN_LEAD_HOURS * HOUR_MS) {
      add(
        "startDate",
        "START_TOO_SOON",
        `Start time must be at least ${CAMPAIGN_MIN_LEAD_HOURS} hours from now`,
      );
    }
    if (endDate.getTime() <= startDate.getTime()) {
      add("endDate", "END_BEFORE_START", "End time must be after the start time");
    } else {
      if (endDate.getTime() - startDate.getTime() > CAMPAIGN_MAX_HOURS_PER_DAY * HOUR_MS) {
        add(
          "endDate",
          "TOO_LONG",
          `A campaign day lasts at most ${CAMPAIGN_MAX_HOURS_PER_DAY} hours`,
        );
      }
      if (localDayKey(startDate) !== localDayKey(endDate)) {
        add(
          "endDate",
          "MULTI_DAY_UNSUPPORTED",
          "The campaign must start and end on the same day",
        );
      }
    }
  }

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

  let totalSlots = 0;
  let anySlots = false;
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
    if (point.slots != null) {
      if (!Number.isInteger(point.slots) || point.slots < 1) {
        add(`${at}.slots`, "SLOTS_INVALID", "Slots must be a positive whole number");
      } else {
        totalSlots += point.slots;
        anySlots = true;
      }
    }
    if (!point.leaderUserId || !ctx.eligibleLeaderIds.has(point.leaderUserId)) {
      add(
        `${at}.leaderUserId`,
        "LEADER_INVALID",
        "The person in charge must be an active member who can manage campaigns",
      );
    }
    if (point.gatherAt && input.startDate && input.endDate) {
      const t = point.gatherAt.getTime();
      // Gathering usually happens shortly before the start, but on the same day.
      if (
        t > input.endDate.getTime() ||
        localDayKey(point.gatherAt) !== localDayKey(input.startDate)
      ) {
        add(
          `${at}.gatherAt`,
          "GATHER_TIME_INVALID",
          "Gathering time must be on the campaign day, before it ends",
        );
      }
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

  if (anySlots && ctx.maxVolunteers != null && totalSlots > ctx.maxVolunteers) {
    add(
      "meetingPoints",
      "SLOTS_OVER_LIMIT",
      `Total slots (${totalSlots}) exceed the ${ctx.maxVolunteers} volunteers allowed for this difficulty`,
    );
  }
}
