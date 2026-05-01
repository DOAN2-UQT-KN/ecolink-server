import type { LeaderboardMetric, SeasonStatus } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { fetchUsersByIds, getUserProfile } from "../../utils/identity-user.client";

export type PublicMetric = "CRP" | "VRP" | "ORG_AGGREGATE";

function toPrismaMetric(m: PublicMetric): LeaderboardMetric {
  return m;
}

export class GamificationLeaderboardService {
  async resolveSeasonId(explicit?: string): Promise<{
    seasonId: string;
    status: SeasonStatus;
  } | null> {
    if (explicit) {
      const s = await prisma.season.findUnique({ where: { id: explicit } });
      return s ? { seasonId: s.id, status: s.status } : null;
    }
    const now = new Date();
    const s =
      (await prisma.season.findFirst({
        where: {
          status: "ACTIVE",
          startsAt: { lte: now },
          endsAt: { gte: now },
        },
        orderBy: { startsAt: "desc" },
      })) ??
      (await prisma.season.findFirst({
        where: { status: "ACTIVE" },
        orderBy: { startsAt: "desc" },
      })) ??
      (await prisma.season.findFirst({ orderBy: { startsAt: "desc" } }));
    return s ? { seasonId: s.id, status: s.status } : null;
  }

  async getLeaderboard(
    metric: PublicMetric,
    page: number,
    limit: number,
    seasonId?: string,
  ) {
    const resolved = await this.resolveSeasonId(seasonId);
    if (!resolved) {
      return { rows: [], total: 0, seasonId: null as string | null };
    }

    const prismaMetric = toPrismaMetric(metric);
    const skip = (page - 1) * limit;

    if (resolved.status === "FROZEN" || resolved.status === "CLOSED") {
      const where = {
        seasonId: resolved.seasonId,
        metric: prismaMetric,
        subjectKind:
          metric === "ORG_AGGREGATE"
            ? ("ORGANIZATION" as const)
            : ("USER" as const),
      };
      const [snaps, total] = await Promise.all([
        prisma.leaderboardSnapshot.findMany({
          where,
          orderBy: { rank: "asc" },
          skip,
          take: limit,
        }),
        prisma.leaderboardSnapshot.count({ where }),
      ]);

      if (metric === "ORG_AGGREGATE") {
        const rows = snaps.map((s) => ({
          rank: s.rank,
          score: s.score,
          organizationId: s.subjectId,
        }));
        return { rows, total, seasonId: resolved.seasonId };
      }

      const userIds = snaps.map((s) => s.subjectId);
      const profileMap = await fetchUsersByIds(userIds);
      const rows = snaps.map((s) => {
        const profile = getUserProfile(profileMap, s.subjectId);
        return {
          rank: s.rank,
          score: s.score,
          userId: s.subjectId,
          user: profile
            ? {
                id: profile.id,
                name: profile.name,
                avatar: profile.avatar,
              }
            : null,
        };
      });
      return { rows, total, seasonId: resolved.seasonId };
    }

    // ACTIVE — live aggregates
    if (metric === "CRP") {
      const [totals, total] = await Promise.all([
        prisma.userSeasonRpTotal.findMany({
          where: { seasonId: resolved.seasonId, citizenRp: { gt: 0 } },
          orderBy: { citizenRp: "desc" },
          skip,
          take: limit,
        }),
        prisma.userSeasonRpTotal.count({
          where: { seasonId: resolved.seasonId, citizenRp: { gt: 0 } },
        }),
      ]);
      const allIds = totals.map((t) => t.userId);
      const profileMap = await fetchUsersByIds(allIds);
      const offset = skip;
      const rows = totals.map((t, i) => {
        const profile = getUserProfile(profileMap, t.userId);
        return {
          rank: offset + i + 1,
          score: t.citizenRp,
          userId: t.userId,
          user: profile
            ? { id: profile.id, name: profile.name, avatar: profile.avatar }
            : null,
        };
      });
      return { rows, total, seasonId: resolved.seasonId };
    }

    if (metric === "VRP") {
      const [totals, total] = await Promise.all([
        prisma.userSeasonRpTotal.findMany({
          where: { seasonId: resolved.seasonId, volunteerRp: { gt: 0 } },
          orderBy: { volunteerRp: "desc" },
          skip,
          take: limit,
        }),
        prisma.userSeasonRpTotal.count({
          where: { seasonId: resolved.seasonId, volunteerRp: { gt: 0 } },
        }),
      ]);
      const allIds = totals.map((t) => t.userId);
      const profileMap = await fetchUsersByIds(allIds);
      const offset = skip;
      const rows = totals.map((t, i) => {
        const profile = getUserProfile(profileMap, t.userId);
        return {
          rank: offset + i + 1,
          score: t.volunteerRp,
          userId: t.userId,
          user: profile
            ? { id: profile.id, name: profile.name, avatar: profile.avatar }
            : null,
        };
      });
      return { rows, total, seasonId: resolved.seasonId };
    }

    // ORG_AGGREGATE
    const [orgs, total] = await Promise.all([
      prisma.organizationSeasonScore.findMany({
        where: { seasonId: resolved.seasonId, aggregateScore: { gt: 0 } },
        orderBy: { aggregateScore: "desc" },
        skip,
        take: limit,
      }),
      prisma.organizationSeasonScore.count({
        where: { seasonId: resolved.seasonId, aggregateScore: { gt: 0 } },
      }),
    ]);
    const offset = skip;
    const rows = orgs.map((o, i) => ({
      rank: offset + i + 1,
      score: o.aggregateScore,
      organizationId: o.organizationId,
    }));
    return { rows, total, seasonId: resolved.seasonId };
  }

  async getLeaderboardMe(
    userId: string,
    metric: PublicMetric,
    seasonId?: string,
  ) {
    const resolved = await this.resolveSeasonId(seasonId);
    if (!resolved) {
      return null;
    }

    const prismaMetric = toPrismaMetric(metric);

    if (resolved.status === "FROZEN" || resolved.status === "CLOSED") {
      if (metric === "ORG_AGGREGATE") {
        return null;
      }
      const snap = await prisma.leaderboardSnapshot.findFirst({
        where: {
          seasonId: resolved.seasonId,
          metric: prismaMetric,
          subjectKind: "USER",
          subjectId: userId,
        },
      });
      return snap
        ? { rank: snap.rank, score: snap.score, seasonId: resolved.seasonId }
        : null;
    }

    if (metric === "CRP") {
      const totals = await prisma.userSeasonRpTotal.findMany({
        where: { seasonId: resolved.seasonId },
        orderBy: { citizenRp: "desc" },
      });
      const idx = totals.findIndex((t) => t.userId === userId);
      if (idx < 0 || totals[idx].citizenRp <= 0) {
        return null;
      }
      return {
        rank: idx + 1,
        score: totals[idx].citizenRp,
        seasonId: resolved.seasonId,
      };
    }

    if (metric === "VRP") {
      const totals = await prisma.userSeasonRpTotal.findMany({
        where: { seasonId: resolved.seasonId },
        orderBy: { volunteerRp: "desc" },
      });
      const idx = totals.findIndex((t) => t.userId === userId);
      if (idx < 0 || totals[idx].volunteerRp <= 0) {
        return null;
      }
      return {
        rank: idx + 1,
        score: totals[idx].volunteerRp,
        seasonId: resolved.seasonId,
      };
    }

    return null;
  }
}

export const gamificationLeaderboardService = new GamificationLeaderboardService();
