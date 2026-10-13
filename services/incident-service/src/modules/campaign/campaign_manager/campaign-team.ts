import { Prisma } from "@prisma/client";
import { OWNER_ROLES } from "@da2/constants";
import prisma from "../../../config/prisma.client";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";

type Db = Prisma.TransactionClient | typeof prisma;

const OWNER_ROLE_VALUES: string[] = [...OWNER_ROLES];

export interface TeamCampaign {
  id?: string | null;
  organizationId: string;
  createdBy: string | null;
  /** The managers about to be saved, in place of the stored ones. */
  managerIds?: string[];
}

/**
 * The campaign's team (spec 3.4): its creator, its active managers and the owners of its
 * organization, all still active members. Only the team may lead a shift.
 * Returns which of `candidateIds` are on it.
 */
export async function findTeamIds(
  db: Db,
  campaign: TeamCampaign,
  candidateIds: string[],
): Promise<Set<string>> {
  const unique = [...new Set(candidateIds)];
  if (unique.length === 0) return new Set();
  const [members, managers] = await Promise.all([
    db.organizationMember.findMany({
      where: { organizationId: campaign.organizationId, userId: { in: unique }, deletedAt: null },
      select: { userId: true, role: true },
    }),
    campaign.managerIds
      ? Promise.resolve(campaign.managerIds.map((userId) => ({ userId })))
      : campaign.id
      ? db.campaignManager.findMany({
          where: { campaignId: campaign.id, userId: { in: unique }, deletedAt: null },
          select: { userId: true },
        })
      : Promise.resolve([] as { userId: string }[]),
  ]);
  const managerIds = new Set(managers.map((m) => m.userId));
  return new Set(
    members
      .filter(
        (m) =>
          m.userId === campaign.createdBy ||
          managerIds.has(m.userId) ||
          OWNER_ROLE_VALUES.includes(m.role),
      )
      .map((m) => m.userId),
  );
}

/** Every shift leader must be on the campaign's team. */
export async function assertLeadersInTeam(
  db: Db,
  campaign: TeamCampaign,
  leaderIds: string[],
): Promise<void> {
  const unique = [...new Set(leaderIds)];
  if (unique.length === 0) return;
  const team = await findTeamIds(db, campaign, unique);
  if (team.size !== unique.length) {
    throw new HttpError(HTTP_STATUS.CAMPAIGN_LEADER_NOT_MANAGER);
  }
}
