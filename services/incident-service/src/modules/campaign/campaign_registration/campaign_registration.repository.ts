import { Prisma, PrismaClient } from "@prisma/client";
import { CAMPAIGN_ABSENCE_WINDOW_DAYS } from "@da2/constants";
import prisma from "../../../config/prisma.client";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Live registrations: not left. */
const live = { leftAt: null } as const;

/** Per-shift registrations (spec 3.1). A volunteer "takes part" in a campaign while they hold one. */
export class CampaignRegistrationRepository {
  constructor(private readonly db: PrismaClient = prisma) {}

  async isRegistered(campaignId: string, userId: string): Promise<boolean> {
    const row = await this.db.campaignShiftRegistration.findFirst({
      where: { campaignId, userId, ...live },
      select: { id: true },
    });
    return row != null;
  }

  /** Distinct registered volunteers per campaign; campaigns with none are omitted. */
  async countVolunteersByCampaignIds(campaignIds: string[]): Promise<Map<string, number>> {
    if (campaignIds.length === 0) return new Map();
    const rows = await this.db.campaignShiftRegistration.findMany({
      where: { campaignId: { in: campaignIds }, ...live },
      select: { campaignId: true, userId: true },
      distinct: ["campaignId", "userId"],
    });
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.campaignId, (out.get(r.campaignId) ?? 0) + 1);
    return out;
  }

  /** Of `campaignIds`, those the user holds a shift in. */
  async findRegisteredCampaignIds(userId: string, campaignIds: string[]): Promise<Set<string>> {
    if (campaignIds.length === 0) return new Set();
    const rows = await this.db.campaignShiftRegistration.findMany({
      where: { userId, campaignId: { in: campaignIds }, ...live },
      select: { campaignId: true },
      distinct: ["campaignId"],
    });
    return new Set(rows.map((r) => r.campaignId));
  }

  /** Live registrations per shift of one campaign. */
  async countByShift(campaignId: string): Promise<Map<string, number>> {
    const groups = await this.db.campaignShiftRegistration.groupBy({
      by: ["shiftId"],
      where: { campaignId, ...live },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.shiftId, g._count._all]));
  }

  async findRegisteredUserIds(campaignId: string): Promise<string[]> {
    const rows = await this.db.campaignShiftRegistration.findMany({
      where: { campaignId, ...live },
      select: { userId: true },
      distinct: ["userId"],
    });
    return rows.map((r) => r.userId);
  }

  /** The shift ids a user holds in a campaign. */
  async findMyShiftIds(campaignId: string, userId: string): Promise<string[]> {
    const rows = await this.db.campaignShiftRegistration.findMany({
      where: { campaignId, userId, ...live },
      select: { shiftId: true },
    });
    return rows.map((r) => r.shiftId);
  }

  /** The user's live shifts in other campaigns that overlap [from, to). */
  async findOverlappingElsewhere(userId: string, campaignId: string, from: Date, to: Date) {
    return this.db.campaignShiftRegistration.findMany({
      where: {
        userId,
        ...live,
        campaignId: { not: campaignId },
        campaign: { deletedAt: null },
        shift: { startAt: { lt: to }, endAt: { gt: from } },
      },
      select: {
        campaignId: true,
        campaign: { select: { title: true } },
        shift: { select: { id: true, startAt: true, endAt: true } },
      },
    });
  }

  /** Registered volunteers of a campaign, one row per person, paginated by first registration. */
  async findVolunteersPaginated(
    campaignId: string,
    filters: { userId?: string },
    options: { skip: number; take: number; sortOrder: "asc" | "desc" },
  ): Promise<{ rows: Array<{ userId: string; registeredAt: Date }>; total: number }> {
    const where: Prisma.CampaignShiftRegistrationWhereInput = {
      campaignId,
      ...live,
      ...(filters.userId ? { userId: filters.userId } : {}),
    };
    const [groups, all] = await Promise.all([
      this.db.campaignShiftRegistration.groupBy({
        by: ["userId"],
        where,
        _min: { createdAt: true },
        orderBy: { _min: { createdAt: options.sortOrder } },
        skip: options.skip,
        take: options.take,
      }),
      this.db.campaignShiftRegistration.findMany({
        where,
        select: { userId: true },
        distinct: ["userId"],
      }),
    ]);
    return {
      rows: groups.map((g) => ({ userId: g.userId, registeredAt: g._min.createdAt ?? new Date(0) })),
      total: all.length,
    };
  }

  /**
   * Absences in the last `CAMPAIGN_ABSENCE_WINDOW_DAYS`, per user. Until attendance is taken per
   * shift (stage 4) this counts the ended shifts a user stayed registered for in a campaign they
   * never checked in to.
   */
  async countRecentAbsences(userIds: string[], now = new Date()): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const since = new Date(now.getTime() - CAMPAIGN_ABSENCE_WINDOW_DAYS * DAY_MS);
    const rows = await this.db.campaignShiftRegistration.findMany({
      where: {
        userId: { in: userIds },
        ...live,
        campaign: { deletedAt: null },
        shift: { endAt: { gte: since, lte: now } },
      },
      select: { userId: true, campaignId: true },
    });
    if (rows.length === 0) return new Map();
    const checkIns = await this.db.campaignAttendanceCheckIn.findMany({
      where: {
        userId: { in: [...new Set(rows.map((r) => r.userId))] },
        campaignId: { in: [...new Set(rows.map((r) => r.campaignId))] },
      },
      select: { userId: true, campaignId: true },
    });
    const attended = new Set(checkIns.map((c) => `${c.userId}:${c.campaignId}`));
    const out = new Map<string, number>();
    for (const r of rows) {
      if (attended.has(`${r.userId}:${r.campaignId}`)) continue;
      out.set(r.userId, (out.get(r.userId) ?? 0) + 1);
    }
    return out;
  }

  /** Late leaves (within the free-leave window) in the last `CAMPAIGN_ABSENCE_WINDOW_DAYS`. */
  async countRecentLateLeaves(userIds: string[], now = new Date()): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const since = new Date(now.getTime() - CAMPAIGN_ABSENCE_WINDOW_DAYS * DAY_MS);
    const groups = await this.db.campaignShiftRegistration.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds }, lateLeave: true, leftAt: { gte: since } },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.userId, g._count._all]));
  }
}

export const campaignRegistrationRepository = new CampaignRegistrationRepository();
