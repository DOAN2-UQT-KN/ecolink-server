import { Prisma } from "@prisma/client";
import { CAMPAIGN_ENDED_STATUSES, OWNER_ROLES } from "@da2/constants";
import { emitOutbox } from "../../../outbox/outbox.writer";
import { OutboxEventType } from "../../../outbox/outbox.types";
import { campaignTitleNotificationPayload } from "../campaign-i18n";
import { localDayMonth, localHourMinute } from "../campaign_registration/staffing-shared";

type Tx = Prisma.TransactionClient;

const OWNER_ROLE_VALUES: string[] = [...OWNER_ROLES];

const liveCampaignWhere = (organizationId: string) => ({
  organizationId,
  deletedAt: null,
  status: { notIn: [...CAMPAIGN_ENDED_STATUSES] },
});

/** The creator and active managers of a campaign, the people team notices go to. */
async function teamRecipients(tx: Tx, campaignId: string): Promise<string[]> {
  const campaign = await tx.campaign.findUnique({
    where: { id: campaignId },
    select: {
      createdBy: true,
      campaignManagers: { where: { deletedAt: null }, select: { userId: true } },
    },
  });
  if (!campaign) return [];
  return [
    ...new Set([
      ...(campaign.createdBy ? [campaign.createdBy] : []),
      ...campaign.campaignManagers.map((m) => m.userId),
    ]),
  ];
}

/**
 * Spec exceptions table: the creator left, so the role goes to the organization's longest-standing
 * owner, who also becomes a manager. Logged, and the team is told.
 */
async function transferCreatorRole(
  tx: Tx,
  organizationId: string,
  userId: string,
  actorId: string,
  now: Date,
): Promise<void> {
  const campaigns = await tx.campaign.findMany({
    where: { ...liveCampaignWhere(organizationId), createdBy: userId },
    select: { id: true, title: true, titleVi: true, titleEn: true },
  });
  if (campaigns.length === 0) return;
  const heir = await tx.organizationMember.findFirst({
    where: {
      organizationId,
      deletedAt: null,
      role: { in: OWNER_ROLE_VALUES },
      userId: { not: userId },
    },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  // Cannot happen: an organization always keeps an owner (DB trigger).
  if (!heir) return;

  for (const campaign of campaigns) {
    await tx.campaign.update({
      where: { id: campaign.id },
      data: { createdBy: heir.userId, updatedBy: actorId },
    });
    await tx.campaignManager.upsert({
      where: { campaignId_userId: { campaignId: campaign.id, userId: heir.userId } },
      create: {
        campaignId: campaign.id,
        userId: heir.userId,
        assignedBy: actorId,
        createdBy: actorId,
        updatedBy: actorId,
      },
      update: { deletedAt: null, updatedBy: actorId },
    });
    await tx.campaignStatusLog.create({
      data: {
        campaignId: campaign.id,
        type: "EDIT",
        event: "transfer_creator",
        actorId,
        actorRole: "system",
        reason: null,
        changes: { createdBy: { from: userId, to: heir.userId } },
      },
    });
    const others = (await teamRecipients(tx, campaign.id)).filter((id) => id !== heir.userId);
    const base = { campaignId: campaign.id, ...campaignTitleNotificationPayload(campaign) };
    const stamp = now.getTime();
    await emitOutbox(tx, {
      aggregateType: "campaign",
      aggregateId: campaign.id,
      eventType: OutboxEventType.WEBSITE_NOTIFICATION,
      dedupKey: `CAMPAIGN_CREATOR_TRANSFERRED:${campaign.id}:${heir.userId}:${stamp}`,
      payload: {
        kind: "CAMPAIGN_CREATOR_TRANSFERRED",
        userIds: [heir.userId],
        payload: { ...base, forYou: "1" },
      },
    });
    if (others.length > 0) {
      await emitOutbox(tx, {
        aggregateType: "campaign",
        aggregateId: campaign.id,
        eventType: OutboxEventType.WEBSITE_NOTIFICATION,
        dedupKey: `CAMPAIGN_CREATOR_TRANSFERRED:${campaign.id}:team:${stamp}`,
        payload: { kind: "CAMPAIGN_CREATOR_TRANSFERRED", userIds: others, payload: base },
      });
    }
  }
}

/**
 * The person no longer may lead shifts: their shifts that have not ended lose their leader, and
 * the team is told so someone is assigned before attendance opens. With `onlyOutsideTeam`, shifts
 * of campaigns where they are still creator or manager are kept.
 */
async function clearLeaderships(
  tx: Tx,
  organizationId: string,
  userId: string,
  actorId: string,
  now: Date,
  onlyOutsideTeam: boolean,
): Promise<void> {
  const shifts = await tx.campaignShift.findMany({
    where: {
      leaderUserId: userId,
      endAt: { gt: now },
      campaign: {
        ...liveCampaignWhere(organizationId),
        ...(onlyOutsideTeam
          ? {
              OR: [{ createdBy: null }, { createdBy: { not: userId } }],
              campaignManagers: { none: { userId, deletedAt: null } },
            }
          : {}),
      },
    },
    orderBy: { startAt: "asc" },
    select: {
      id: true,
      campaignId: true,
      startAt: true,
      minVolunteers: true,
      meetingPoint: { select: { name: true, sortOrder: true } },
      campaign: { select: { title: true, titleVi: true, titleEn: true } },
    },
  });
  if (shifts.length === 0) return;

  const byCampaign = new Map<string, typeof shifts>();
  for (const s of shifts) {
    byCampaign.set(s.campaignId, [...(byCampaign.get(s.campaignId) ?? []), s]);
  }
  for (const [campaignId, list] of byCampaign) {
    await tx.campaignShift.updateMany({
      where: { id: { in: list.map((s) => s.id) } },
      data: { leaderUserId: null },
    });
    await tx.campaignStatusLog.create({
      data: {
        campaignId,
        type: "EDIT",
        event: "clear_shift_leader",
        actorId,
        actorRole: "system",
        reason: null,
        changes: { leaderUserId: userId, shiftIds: list.map((s) => s.id) },
      },
    });
    // Turned-off shifts need no leader, so only running ones are worth a notice.
    const running = list.filter((s) => s.minVolunteers > 0);
    const recipients = (await teamRecipients(tx, campaignId)).filter((id) => id !== userId);
    if (running.length === 0 || recipients.length === 0) continue;
    await emitOutbox(tx, {
      aggregateType: "campaign",
      aggregateId: campaignId,
      eventType: OutboxEventType.WEBSITE_NOTIFICATION,
      dedupKey: `CAMPAIGN_SHIFT_LEADER_REMOVED:${campaignId}:${userId}:${now.getTime()}`,
      payload: {
        kind: "CAMPAIGN_SHIFT_LEADER_REMOVED",
        userIds: recipients,
        payload: {
          campaignId,
          shifts: running
            .map(
              (s) =>
                `${s.meetingPoint.name || `#${s.meetingPoint.sortOrder + 1}`} ${localHourMinute(s.startAt)} ${localDayMonth(s.startAt)}`,
            )
            .join(" · "),
          ...campaignTitleNotificationPayload(list[0].campaign),
        },
      },
    });
  }
}

/**
 * Someone left, or was removed from, an organization (spec 3.4): they stop managing its campaigns,
 * the campaigns they created pass to the longest-standing owner, and their shifts lose their
 * leader. Runs inside the membership change's transaction.
 */
export async function onMemberGone(
  tx: Tx,
  organizationId: string,
  userId: string,
  actorId: string,
  now = new Date(),
): Promise<void> {
  await tx.campaignManager.updateMany({
    where: { userId, deletedAt: null, campaign: { organizationId } },
    data: { deletedAt: now, updatedBy: actorId },
  });
  await transferCreatorRole(tx, organizationId, userId, actorId, now);
  await clearLeaderships(tx, organizationId, userId, actorId, now, false);
}

/**
 * Someone's role changed. An owner now with a lesser role who stays a member: they keep the campaigns they create or
 * manage, and lose the shifts they led only as an owner.
 */
export async function onRightsReduced(
  tx: Tx,
  organizationId: string,
  userId: string,
  actorId: string,
  now = new Date(),
): Promise<void> {
  const member = await tx.organizationMember.findFirst({
    where: { organizationId, userId, deletedAt: null },
    select: { role: true },
  });
  if (!member) return onMemberGone(tx, organizationId, userId, actorId, now);
  if (OWNER_ROLE_VALUES.includes(member.role)) return;
  await clearLeaderships(tx, organizationId, userId, actorId, now, true);
}
