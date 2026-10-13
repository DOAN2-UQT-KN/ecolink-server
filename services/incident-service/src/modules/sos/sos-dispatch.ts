import { Prisma, type Sos } from "@prisma/client";
import {
  CampaignStatus,
  SOS_DAILY_INVITES,
  SOS_NEARBY_ORG_RADIUS_KM,
  SOS_RESPONDER_STATUS,
  SOS_TYPE,
} from "@da2/constants";
import { emitOutbox } from "../../outbox/outbox.writer";
import { OutboxEventType } from "../../outbox/outbox.types";
import { getCampaignAdminNotifyUserIds } from "../campaign/campaign-completion-admin-notify.config";
import { campaignTitleNotificationPayload } from "../campaign/campaign-i18n";
import { managerRecipients } from "../campaign/campaign_registration/staffing-shared";
import { organizationMemberRepository } from "../organization/organization_member.repository";
import { frontendBaseUrl } from "../organization_application/organization-application-urls";

type Tx = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Asia/Ho_Chi_Minh, no daylight saving: "Sẵn sàng" hours and the daily cap are local. */
const LOCAL_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Who gets an SOS notification, recorded in `sos_deliveries.tier`. */
export const SOS_TIER = { TEAM: 0, AVAILABLE: 1, NEARBY_ORG: 2, ADMIN: 3 } as const;

export const SOS_KIND = {
  TEAM_ALERT: "SOS_TEAM_ALERT",
  MEDICAL_ALERT: "SOS_MEDICAL_ALERT",
  HELP_INVITE: "SOS_HELP_INVITE",
  HAZARD_WARNING: "SOS_HAZARD_WARNING",
  NEARBY_ORG_REQUEST: "SOS_NEARBY_ORG_REQUEST",
  ADMIN_ALERT: "SOS_ADMIN_ALERT",
  OWNER_ESCALATION: "SOS_OWNER_ESCALATION",
  ESCALATED: "SOS_ESCALATED",
  LOCATION_CHANGED: "SOS_LOCATION_CHANGED",
  EXPIRED: "SOS_EXPIRED",
  NO_LONGER_NEEDED: "SOS_NO_LONGER_NEEDED",
  ABUSE_REVIEW: "SOS_ABUSE_REVIEW",
} as const;

const TYPE_LABEL: Record<string, { en: string; vi: string }> = {
  [SOS_TYPE.MANPOWER]: { en: "people / tools", vi: "Nhân lực / Dụng cụ" },
  [SOS_TYPE.HAZARD]: { en: "hazardous waste", vi: "Rác nguy hại" },
  [SOS_TYPE.MEDICAL]: { en: "medical / accident", vi: "Y tế / Tai nạn" },
};

/** What dispatch needs to know about the SOS's campaign, shift and meeting point. */
export interface SosContext {
  campaign: {
    id: string;
    title: string;
    titleVi: string | null;
    titleEn: string | null;
    organizationId: string;
    createdBy: string | null;
    campaignManagers: Array<{ userId: string }>;
  };
  leaderUserId: string | null;
  meetingPointName: string | null;
}

export async function loadSosContext(tx: Tx, sos: Sos): Promise<SosContext> {
  const campaign = await tx.campaign.findUniqueOrThrow({
    where: { id: sos.campaignId },
    select: {
      id: true,
      title: true,
      titleVi: true,
      titleEn: true,
      organizationId: true,
      createdBy: true,
      campaignManagers: { where: { deletedAt: null }, select: { userId: true } },
    },
  });
  const shift = sos.shiftId
    ? await tx.campaignShift.findUnique({ where: { id: sos.shiftId }, select: { leaderUserId: true } })
    : null;
  const point = sos.meetingPointId
    ? await tx.campaignMeetingPoint.findUnique({ where: { id: sos.meetingPointId }, select: { name: true } })
    : null;
  return { campaign, leaderUserId: shift?.leaderUserId ?? null, meetingPointName: point?.name ?? null };
}

/** Strings every SOS template can use; `sosUrl` for the emails. */
export function sosPayload(sos: Sos, ctx: SosContext, extra: Record<string, string> = {}): Record<string, string> {
  const label = TYPE_LABEL[sos.type] ?? TYPE_LABEL[SOS_TYPE.MANPOWER];
  const details = (sos.details ?? {}) as Record<string, unknown>;
  return {
    sosId: String(sos.id),
    campaignId: sos.campaignId,
    ...campaignTitleNotificationPayload(ctx.campaign),
    sosType: sos.type,
    sosTypeEn: label.en,
    sosTypeVi: label.vi,
    sosUrl: `${frontendBaseUrl()}/sos/${sos.id}`,
    ...(ctx.meetingPointName ? { meetingPointName: ctx.meetingPointName } : {}),
    ...(typeof details.peopleNeeded === "number" ? { peopleNeeded: String(details.peopleNeeded) } : {}),
    ...(sos.type === SOS_TYPE.MEDICAL ? { medical: "1" } : {}),
    ...extra,
  };
}

/**
 * Sends one kind to users through the outbox, in `tx`. With a `tier` it is a dispatch: recorded in
 * `sos_deliveries`, and a user who already got this kind for this SOS is skipped. Returns who got it.
 */
export async function sendSosNotice(
  tx: Tx,
  sos: Sos,
  ctx: SosContext,
  args: {
    kind: string;
    userIds: string[];
    tier?: number;
    email?: boolean;
    dedupKey: string;
    extra?: Record<string, string>;
  },
): Promise<string[]> {
  let userIds = [...new Set(args.userIds.filter(Boolean))];
  if (args.tier !== undefined && userIds.length > 0) {
    const already = await tx.sosDelivery.findMany({
      where: { sosId: sos.id, kind: args.kind, userId: { in: userIds } },
      select: { userId: true },
    });
    const sent = new Set(already.map((d) => d.userId));
    userIds = userIds.filter((u) => !sent.has(u));
    if (userIds.length > 0) {
      await tx.sosDelivery.createMany({
        data: userIds.map((userId) => ({ sosId: sos.id, userId, tier: args.tier!, kind: args.kind })),
        skipDuplicates: true,
      });
    }
  }
  if (userIds.length === 0) return [];
  await emitOutbox(tx, {
    aggregateType: "campaign",
    aggregateId: sos.campaignId,
    eventType: OutboxEventType.WEBSITE_NOTIFICATION,
    dedupKey: args.dedupKey,
    payload: {
      kind: args.kind,
      userIds,
      payload: sosPayload(sos, ctx, args.extra),
      ...(args.email ? { email: true } : {}),
    },
  });
  return userIds;
}

/** Volunteers checked in on the SOS's shift and still there. */
async function checkedInVolunteers(tx: Tx, sos: Sos): Promise<string[]> {
  if (!sos.shiftId) return [];
  const rows = await tx.campaignShiftAttendance.findMany({
    where: { shiftId: sos.shiftId, checkOutAt: null, excludedAt: null },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** People on the way to (or already at) the SOS. */
export async function activeResponderIds(
  tx: Tx,
  sosId: number,
  statuses: string[] = [SOS_RESPONDER_STATUS.ON_THE_WAY, SOS_RESPONDER_STATUS.ARRIVED],
): Promise<string[]> {
  const rows = await tx.sosResponder.findMany({
    where: { sosId, status: { in: statuses } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** Manpower: enough people are on the way or there (no number asked = one is enough). */
export async function manpowerCovered(tx: Tx, sos: Sos): Promise<boolean> {
  const needed = (sos.details as Record<string, unknown>)?.peopleNeeded;
  const count = (await activeResponderIds(tx, sos.id)).length;
  return count >= (typeof needed === "number" && needed > 0 ? needed : 1);
}

/** Within a "Sẵn sàng" schedule at `now` (local time); an empty schedule is always. */
export function inSchedule(schedule: unknown, now: Date): boolean {
  if (!Array.isArray(schedule) || schedule.length === 0) return true;
  const local = new Date(now.getTime() + LOCAL_UTC_OFFSET_MS);
  const day = local.getUTCDay();
  const hm = local.toISOString().slice(11, 16);
  return schedule.some((w: { days?: unknown; from?: unknown; to?: unknown }) =>
    Array.isArray(w?.days) &&
    w.days.includes(day) &&
    typeof w.from === "string" &&
    typeof w.to === "string" &&
    w.from <= hm &&
    hm < w.to,
  );
}

const localDayStart = (now: Date) =>
  new Date(Math.floor((now.getTime() + LOCAL_UTC_OFFSET_MS) / DAY_MS) * DAY_MS - LOCAL_UTC_OFFSET_MS);

/**
 * Priority 1: "available" volunteers within `radius_km` of the SOS, in their hours, outside the
 * campaign's team, under 5 SOS notifications today (medical not counted). Hazard only warns them;
 * manpower stops inviting once enough people are coming.
 */
export async function inviteAvailableVolunteers(
  tx: Tx,
  sos: Sos,
  ctx: SosContext,
  exclude: string[],
  now: Date,
): Promise<string[]> {
  if (sos.type === SOS_TYPE.MANPOWER && (await manpowerCovered(tx, sos))) return [];
  const rows = await tx.$queryRaw<Array<{ user_id: string; schedule: unknown }>>`
    SELECT user_id, schedule
    FROM volunteer_availabilities
    WHERE enabled = true
      AND approx_lat IS NOT NULL AND approx_lng IS NOT NULL
      AND ST_DWithin(
        ST_SetSRID(ST_MakePoint(approx_lng, approx_lat), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${sos.longitude}, ${sos.latitude}), 4326)::geography,
        ${sos.radiusKm * 1000}
      )`;
  const skip = new Set([...exclude, ...(sos.createdBy ? [sos.createdBy] : [])]);
  let candidates = rows.filter((r) => !skip.has(r.user_id) && inSchedule(r.schedule, now)).map((r) => r.user_id);
  if (candidates.length === 0) return [];

  if (sos.type !== SOS_TYPE.MEDICAL) {
    const today = await tx.sosDelivery.findMany({
      where: {
        userId: { in: candidates },
        tier: SOS_TIER.AVAILABLE,
        createdAt: { gte: localDayStart(now) },
        sos: { type: { not: SOS_TYPE.MEDICAL } },
      },
      select: { userId: true },
    });
    const count = new Map<string, number>();
    for (const d of today) count.set(d.userId, (count.get(d.userId) ?? 0) + 1);
    candidates = candidates.filter((u) => (count.get(u) ?? 0) < SOS_DAILY_INVITES);
  }
  const kind = sos.type === SOS_TYPE.HAZARD ? SOS_KIND.HAZARD_WARNING : SOS_KIND.HELP_INVITE;
  return sendSosNotice(tx, sos, ctx, {
    kind,
    userIds: candidates,
    tier: SOS_TIER.AVAILABLE,
    dedupKey: `${kind}:${sos.id}:${sos.radiusKm}`,
  });
}

/**
 * Other organizations near the SOS: their own location, or a meeting point of one of their
 * upcoming / active campaigns, within 5 km.
 */
export async function nearbyOrganizationIds(tx: Tx, sos: Sos, organizationId: string): Promise<string[]> {
  const metres = SOS_NEARBY_ORG_RADIUS_KM * 1000;
  const here = Prisma.sql`ST_SetSRID(ST_MakePoint(${sos.longitude}, ${sos.latitude}), 4326)::geography`;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT o.id
    FROM organizations o
    WHERE o.deleted_at IS NULL
      AND o.status = 1
      AND o.id <> ${organizationId}::uuid
      AND (
        (o.latitude IS NOT NULL AND o.longitude IS NOT NULL
          AND ST_DWithin(ST_SetSRID(ST_MakePoint(o.longitude, o.latitude), 4326)::geography, ${here}, ${metres}))
        OR EXISTS (
          SELECT 1
          FROM campaigns c
          JOIN campaign_meeting_points mp ON mp.campaign_id = c.id AND mp.deleted_at IS NULL
          WHERE c.organization_id = o.id
            AND c.deleted_at IS NULL
            AND c.status IN (${CampaignStatus.UPCOMING}, ${CampaignStatus.ACTIVE})
            AND ST_DWithin(ST_SetSRID(ST_MakePoint(mp.longitude, mp.latitude), 4326)::geography, ${here}, ${metres})
        )
      )`;
  return rows.map((r) => r.id);
}

/**
 * Priority 2: owners of nearby organizations, asked to lend people or tools. Manpower also asks
 * the admins here; hazard and medical reach the admins through priority 3 instead.
 */
export async function askNearbyOrganizations(tx: Tx, sos: Sos, ctx: SosContext): Promise<string[]> {
  const orgIds = await nearbyOrganizationIds(tx, sos, ctx.campaign.organizationId);
  const owners = [...(await organizationMemberRepository.findOwnersByOrganizationIds(orgIds)).values()]
    .flat()
    .map((o) => o.userId);
  const admins = sos.type === SOS_TYPE.MANPOWER ? getCampaignAdminNotifyUserIds() : [];
  return sendSosNotice(tx, sos, ctx, {
    kind: SOS_KIND.NEARBY_ORG_REQUEST,
    userIds: [...owners, ...admins],
    tier: SOS_TIER.NEARBY_ORG,
    dedupKey: `${SOS_KIND.NEARBY_ORG_REQUEST}:${sos.id}`,
  });
}

export async function ownerIds(ctx: SosContext): Promise<string[]> {
  return organizationMemberRepository.findOwnerUserIds(ctx.campaign.organizationId);
}

/**
 * Right after an SOS is created (spec "Người nhận thông báo theo ưu tiên"):
 *   - every type: the shift's leader, the campaign's managers, volunteers checked in on the shift
 *     (hazard: the volunteers also get the "do not touch" warning)
 *   - medical: the owners and the admins at once, in-app and by email
 *   - priority 1 at once; hazard / medical also priority 2 and 3 (admin alert + email for hazard)
 */
export async function dispatchOnCreate(tx: Tx, sos: Sos, ctx: SosContext, now: Date): Promise<void> {
  const volunteers = await checkedInVolunteers(tx, sos);
  const team = [
    ...(ctx.leaderUserId ? [ctx.leaderUserId] : []),
    ...managerRecipients(ctx.campaign),
    ...volunteers,
  ].filter((u) => u !== sos.createdBy);
  await sendSosNotice(tx, sos, ctx, {
    kind: SOS_KIND.TEAM_ALERT,
    userIds: team,
    tier: SOS_TIER.TEAM,
    dedupKey: `${SOS_KIND.TEAM_ALERT}:${sos.id}`,
  });
  if (sos.type === SOS_TYPE.HAZARD) {
    await sendSosNotice(tx, sos, ctx, {
      kind: SOS_KIND.HAZARD_WARNING,
      userIds: volunteers.filter((u) => u !== sos.createdBy),
      tier: SOS_TIER.TEAM,
      dedupKey: `${SOS_KIND.HAZARD_WARNING}:${sos.id}:team`,
    });
  }
  const owners = await ownerIds(ctx);
  if (sos.type === SOS_TYPE.MEDICAL) {
    await sendSosNotice(tx, sos, ctx, {
      kind: SOS_KIND.MEDICAL_ALERT,
      userIds: [...owners, ...getCampaignAdminNotifyUserIds()].filter((u) => u !== sos.createdBy),
      tier: SOS_TIER.ADMIN,
      email: true,
      dedupKey: `${SOS_KIND.MEDICAL_ALERT}:${sos.id}`,
    });
  }

  await inviteAvailableVolunteers(tx, sos, ctx, [...team, ...owners], now);

  if (sos.type === SOS_TYPE.HAZARD || sos.type === SOS_TYPE.MEDICAL) {
    await askNearbyOrganizations(tx, sos, ctx);
  }
  if (sos.type === SOS_TYPE.HAZARD) {
    await sendSosNotice(tx, sos, ctx, {
      kind: SOS_KIND.ADMIN_ALERT,
      userIds: getCampaignAdminNotifyUserIds(),
      tier: SOS_TIER.ADMIN,
      email: true,
      dedupKey: `${SOS_KIND.ADMIN_ALERT}:${sos.id}`,
    });
  }
}

/** The team members and owners, to keep out of priority 1 on a later round. */
export async function teamAndOwnerIds(tx: Tx, sos: Sos, ctx: SosContext): Promise<string[]> {
  return [
    ...(ctx.leaderUserId ? [ctx.leaderUserId] : []),
    ...managerRecipients(ctx.campaign),
    ...(await checkedInVolunteers(tx, sos)),
    ...(await ownerIds(ctx)),
  ];
}

/**
 * The SOS closed (resolved, expired): the people still on the way stop (so they may respond to
 * another one) and hear `kind`. Those already there are left as they are.
 */
export async function closeResponders(
  tx: Tx,
  sos: Sos,
  ctx: SosContext,
  kind: string,
  now: Date,
): Promise<void> {
  const onTheWay = await tx.sosResponder.findMany({
    where: { sosId: sos.id, status: SOS_RESPONDER_STATUS.ON_THE_WAY },
    select: { userId: true },
  });
  if (onTheWay.length === 0) return;
  await tx.sosResponder.updateMany({
    where: { sosId: sos.id, status: SOS_RESPONDER_STATUS.ON_THE_WAY },
    data: { status: SOS_RESPONDER_STATUS.CANCELLED, cancelledAt: now },
  });
  await sendSosNotice(tx, sos, ctx, {
    kind,
    userIds: onTheWay.map((r) => r.userId),
    dedupKey: `${kind}:${sos.id}`,
  });
}
