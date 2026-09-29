import {
  Campaign,
  CampaignManager,
  CampaignMeetingPoint,
  CampaignMeetingPointReport,
  Report,
} from "@prisma/client";
import type { AppLocale, CampaignRequirements } from "@da2/constants";
import { pickLocalizedText, toLocalizedText } from "@da2/constants";
import { defaultCampaignCompletionVerificationSummary } from "./campaign_completion_verification/campaign_completion_verification.dto";
import { defaultResourceVoteSummary } from "../vote/vote.dto";
import { CampaignResponse, MeetingPointResponse } from "./campaign.dto";

export type CampaignEntity = Campaign;

export type MeetingPointWithReports = CampaignMeetingPoint & {
  reports: Pick<CampaignMeetingPointReport, "reportId">[];
};

export type CampaignWithReports = Campaign & {
  reports: Pick<Report, "id">[];
  campaignManagers: Pick<CampaignManager, "userId">[];
  meetingPoints?: MeetingPointWithReports[];
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
  gatherAt: point.gatherAt,
  slots: point.slots,
  leaderUserId: point.leaderUserId,
  sortOrder: point.sortOrder,
  reportIds: point.reports.map((r) => r.reportId),
});

export const toCampaignResponse = (
  entity: CampaignWithReports,
  greenPoints: number,
  currentMembers: number,
  maxMembers: number | null,
  locale?: AppLocale | null,
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
    startDate: entity.startDate,
    endDate: entity.endDate,
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
    meetingPoints: (entity.meetingPoints ?? []).map(toMeetingPointResponse),
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
    completionVerification: defaultCampaignCompletionVerificationSummary(null),
    saved: null,
  };
};
