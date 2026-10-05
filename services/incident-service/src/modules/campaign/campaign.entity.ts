import {
  Campaign,
  CampaignDay,
  CampaignManager,
  CampaignMeetingPoint,
  CampaignMeetingPointReport,
  CampaignShift,
  Report,
} from "@prisma/client";
import type { AppLocale, CampaignRequirements } from "@da2/constants";
import { pickLocalizedText, toLocalizedText } from "@da2/constants";
import { defaultResourceVoteSummary } from "../vote/vote.dto";
import {
  CampaignDayResponse,
  CampaignResponse,
  CampaignShiftResponse,
  MeetingPointResponse,
} from "./campaign.dto";
import { shiftStatusOf } from "./campaign_shift_result/shift-status";

export type CampaignEntity = Campaign;

export type MeetingPointWithReports = CampaignMeetingPoint & {
  reports: Pick<CampaignMeetingPointReport, "reportId">[];
};

export type CampaignWithReports = Campaign & {
  reports: Pick<Report, "id">[];
  campaignManagers: Pick<CampaignManager, "userId">[];
  meetingPoints?: MeetingPointWithReports[];
  days?: CampaignDay[];
  shifts?: CampaignShiftWithResult[];
};

/** A shift with whether it has a result, which its status needs (spec 4.2). */
export type CampaignShiftWithResult = CampaignShift & {
  result?: { id: string; reopenedAt?: Date | null; reopenReason?: string | null } | null;
};

/** The relations every campaign read loads (managers, locked reports, meeting points). */
export const CAMPAIGN_INCLUDE = {
  campaignManagers: {
    where: { deletedAt: null },
    select: { userId: true },
  },
  reports: {
    where: { deletedAt: null },
    select: { id: true },
  },
  meetingPoints: {
    where: { deletedAt: null },
    orderBy: { sortOrder: "asc" },
    include: { reports: { select: { reportId: true } } },
  },
  days: { orderBy: { startAt: "asc" } },
  shifts: { include: { result: { select: { id: true, reopenedAt: true, reopenReason: true } } } },
} as const;

export const toMeetingPointResponse = (
  point: MeetingPointWithReports,
): MeetingPointResponse => ({
  id: point.id,
  name: point.name,
  latitude: point.latitude,
  longitude: point.longitude,
  detailAddress: point.detailAddress,
  radiusKm: point.radiusKm,
  sortOrder: point.sortOrder,
  reportIds: point.reports.map((r) => r.reportId),
});

export const toCampaignDayResponse = (day: CampaignDay): CampaignDayResponse => ({
  id: day.id,
  startAt: day.startAt,
  endAt: day.endAt,
  sortOrder: day.sortOrder,
});

export const toCampaignShiftResponse = (
  shift: CampaignShiftWithResult,
  now = new Date(),
): CampaignShiftResponse => ({
  id: shift.id,
  dayId: shift.dayId,
  meetingPointId: shift.meetingPointId,
  startAt: shift.startAt,
  endAt: shift.endAt,
  gatherAt: shift.gatherAt,
  minVolunteers: shift.minVolunteers,
  maxVolunteers: shift.maxVolunteers,
  leaderUserId: shift.leaderUserId,
  endedAt: shift.endedAt,
  status: shiftStatusOf(shift, shift.result, now),
  reopenedAt: shift.result?.reopenedAt ?? null,
  reopenReason: shift.result?.reopenedAt ? (shift.result.reopenReason ?? null) : null,
});

/** First start and last end of a campaign's days; null when it has none yet. */
export const campaignSpan = (
  days: Pick<CampaignDay, "startAt" | "endAt">[] | undefined,
): { startAt: Date; endAt: Date } | null => {
  if (!days || days.length === 0) return null;
  let startAt = days[0].startAt;
  let endAt = days[0].endAt;
  for (const d of days) {
    if (d.startAt < startAt) startAt = d.startAt;
    if (d.endAt > endAt) endAt = d.endAt;
  }
  return { startAt, endAt };
};

export const toCampaignResponse = (
  entity: CampaignWithReports,
  greenPoints: number,
  currentMembers: number,
  maxMembers: number | null,
  locale?: AppLocale | null,
  suggestedMinVolunteers: number | null = null,
): CampaignResponse => {
  const managerIds = entity.campaignManagers.map((manager) => manager.userId);
  const titleLoc = toLocalizedText({
    title: entity.title,
    titleVi: entity.titleVi,
    titleEn: entity.titleEn,
  });
  const descLoc = toLocalizedText({
    title: entity.description,
    titleVi: entity.descriptionVi,
    titleEn: entity.descriptionEn,
  });
  const loc = locale ?? "en";

  return {
    id: entity.id,
    organizationId: entity.organizationId,
    Organization: undefined,
    owner: null,
    title: pickLocalizedText(titleLoc, loc),
    titleVi: entity.titleVi ?? entity.title,
    titleEn: entity.titleEn ?? null,
    banner: entity.banner,
    description: pickLocalizedText(descLoc, loc),
    descriptionVi: entity.descriptionVi ?? entity.description,
    descriptionEn: entity.descriptionEn ?? null,
    status: entity.status,
    rejectReason: entity.rejectReason ?? null,
    detailAddress: entity.detailAddress,
    latitude: entity.latitude,
    longitude: entity.longitude,
    radiusKm: entity.radiusKm,
    difficulty: entity.difficulty,
    contactName: entity.contactName ?? null,
    // Hidden by default; the service reveals it to managers, admins and accepted volunteers.
    contactPhone: null,
    safetyNotes: entity.safetyNotes ?? null,
    requirements: (entity.requirements as CampaignRequirements | null) ?? null,
    revisionDeadline: entity.revisionDeadline ?? null,
    submittedAt: entity.submittedAt ?? null,
    approvedAt: entity.approvedAt ?? null,
    completionSubmittedAt: entity.completionSubmittedAt ?? null,
    completionRejectionCount: entity.completionRejectionCount ?? 0,
    completionAwaitingAdmin: entity.completionAwaitingAdmin ?? false,
    minVolunteersReason: entity.minVolunteersReason ?? null,
    suggestedMinVolunteers,
    days: (entity.days ?? []).map(toCampaignDayResponse),
    meetingPoints: (entity.meetingPoints ?? []).map(toMeetingPointResponse),
    shifts: (entity.shifts ?? []).map((s) => toCampaignShiftResponse(s)),
    greenPoints,
    currentMembers,
    maxMembers,
    createdBy: entity.createdBy,
    updatedBy: entity.updatedBy,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    reports: [],
    managers: managerIds.map((id) => ({ id, name: "", avatar: null })),
    votes: defaultResourceVoteSummary(null),
    saved: null,
  };
};
