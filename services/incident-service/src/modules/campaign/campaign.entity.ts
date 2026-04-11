import { Campaign, CampaignManager, Report } from "@prisma/client";
import { defaultResourceVoteSummary } from "../vote/vote.dto";
import { CampaignResponse } from "./campaign.dto";

export type CampaignEntity = Campaign;

export type CampaignWithReports = Campaign & {
  reports: Pick<Report, "id">[];
  campaignManagers: Pick<CampaignManager, "userId">[];
};

export const toCampaignResponse = (
  entity: CampaignWithReports,
  greenPoints: number,
): CampaignResponse => {
  const managerIds = entity.campaignManagers.map((manager) => manager.userId);

  return {
    id: entity.id,
    organizationId: entity.organizationId,
    title: entity.title,
    description: entity.description,
    status: entity.status,
    difficulty: entity.difficulty,
    greenPoints,
    isVerify: entity.isVerify,
    createdBy: entity.createdBy,
    updatedBy: entity.updatedBy,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    reportIds: entity.reports.map((report) => report.id),
    managerIds,
    votes: defaultResourceVoteSummary(null),
    saved: null,
  };
};
