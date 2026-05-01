import { randomUUID } from "crypto";
import type {
  LeaderboardMetric,
  SeasonKind,
  SeasonStatus,
} from "@prisma/client";
import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";

export type SeasonResponse = {
  id: string;
  label: string | null;
  kind: SeasonKind;
  status: SeasonStatus;
  startsAt: string;
  endsAt: string;
};

function toSeasonResponse(row: {
  id: string;
  label: string | null;
  kind: SeasonKind;
  status: SeasonStatus;
  startsAt: Date;
  endsAt: Date;
}): SeasonResponse {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    status: row.status,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
  };
}

export class SeasonService {
  /**
   * Prefer calendar-active row; otherwise latest ACTIVE by `startsAt`; otherwise latest by `startsAt`.
   */
  async getCurrentSeason(): Promise<SeasonResponse | null> {
    const now = new Date();

    const activeInWindow = await prisma.season.findFirst({
      where: {
        status: "ACTIVE",
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
      orderBy: { startsAt: "desc" },
    });
    if (activeInWindow) {
      return toSeasonResponse(activeInWindow);
    }

    const activeAny = await prisma.season.findFirst({
      where: { status: "ACTIVE" },
      orderBy: { startsAt: "desc" },
    });
    if (activeAny) {
      return toSeasonResponse(activeAny);
    }

    const latest = await prisma.season.findFirst({
      orderBy: { startsAt: "desc" },
    });
    return latest ? toSeasonResponse(latest) : null;
  }

  async getById(id: string): Promise<SeasonResponse | null> {
    const row = await prisma.season.findUnique({ where: { id } });
    return row ? toSeasonResponse(row) : null;
  }

  async listAdmin(page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      prisma.season.findMany({
        orderBy: { startsAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.season.count(),
    ]);
    return {
      seasons: rows.map(toSeasonResponse),
      total,
      page,
      limit,
    };
  }

  async createSeason(body: {
    label?: string | null;
    kind: SeasonKind;
    startsAt: Date;
    endsAt: Date;
    status?: SeasonStatus;
  }): Promise<SeasonResponse> {
    const row = await prisma.season.create({
      data: {
        id: randomUUID(),
        label: body.label ?? null,
        kind: body.kind,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        status: body.status ?? "ACTIVE",
      },
    });
    return toSeasonResponse(row);
  }

  async patchSeason(
    id: string,
    body: Partial<{
      label: string | null;
      startsAt: Date;
      endsAt: Date;
      status: SeasonStatus;
      kind: SeasonKind;
    }>,
  ): Promise<SeasonResponse | null> {
    try {
      const row = await prisma.season.update({
        where: { id },
        data: body,
      });
      return toSeasonResponse(row);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2025"
      ) {
        return null;
      }
      throw e;
    }
  }

  /**
   * Freeze season: rebuild leaderboard snapshots from live aggregates; optional SP payouts from tiers.
   */
  async freezeSeason(seasonId: string): Promise<{ snapshotsWritten: number }> {
    return prisma.$transaction(async (tx) => {
      const season = await tx.season.findUnique({ where: { id: seasonId } });
      if (!season) {
        throw new Error("SEASON_NOT_FOUND");
      }
      if (season.status !== "ACTIVE") {
        throw new Error("SEASON_NOT_ACTIVE");
      }

      await tx.leaderboardSnapshot.deleteMany({ where: { seasonId } });

      const crpRows = await tx.userSeasonRpTotal.findMany({
        where: { seasonId },
        orderBy: { citizenRp: "desc" },
      });
      const vrpRows = await tx.userSeasonRpTotal.findMany({
        where: { seasonId },
        orderBy: { volunteerRp: "desc" },
      });
      const orgRows = await tx.organizationSeasonScore.findMany({
        where: { seasonId },
        orderBy: { aggregateScore: "desc" },
      });

      let snapshotsWritten = 0;

      let rank = 0;
      for (const r of crpRows) {
        rank += 1;
        await tx.leaderboardSnapshot.create({
          data: {
            id: randomUUID(),
            seasonId,
            subjectKind: "USER",
            subjectId: r.userId,
            metric: "CRP",
            score: r.citizenRp,
            rank,
          },
        });
        snapshotsWritten += 1;
      }

      rank = 0;
      for (const r of vrpRows) {
        rank += 1;
        await tx.leaderboardSnapshot.create({
          data: {
            id: randomUUID(),
            seasonId,
            subjectKind: "USER",
            subjectId: r.userId,
            metric: "VRP",
            score: r.volunteerRp,
            rank,
          },
        });
        snapshotsWritten += 1;
      }

      rank = 0;
      for (const r of orgRows) {
        rank += 1;
        await tx.leaderboardSnapshot.create({
          data: {
            id: randomUUID(),
            seasonId,
            subjectKind: "ORGANIZATION",
            subjectId: r.organizationId,
            metric: "ORG_AGGREGATE",
            score: r.aggregateScore,
            rank,
          },
        });
        snapshotsWritten += 1;
      }

      await tx.season.update({
        where: { id: seasonId },
        data: { status: "FROZEN" },
      });

      await this.applyPayoutTiersTx(tx, seasonId);

      return { snapshotsWritten };
    });
  }

  /**
   * SP payouts for USER metrics only (CRP / VRP), based on snapshot ranks.
   */
  private async applyPayoutTiersTx(
    tx: Prisma.TransactionClient,
    seasonId: string,
  ): Promise<void> {
    const spRule = await tx.spendablePointRules.findFirst({
      where: { isActive: true },
      orderBy: { effectiveFrom: "desc" },
    });
    const expirationDays = spRule?.expirationDays ?? 90;

    const tiers = await tx.seasonLeaderboardPayoutTier.findMany({
      where: {
        OR: [{ seasonId }, { seasonId: null }],
        metric: { in: ["CRP", "VRP"] },
      },
    });

    const seasonScoped = tiers.filter((t) => t.seasonId === seasonId);
    const useTiers = seasonScoped.length > 0 ? seasonScoped : tiers.filter((t) => !t.seasonId);

    for (const tier of useTiers) {
      const snaps = await tx.leaderboardSnapshot.findMany({
        where: {
          seasonId,
          metric: tier.metric as LeaderboardMetric,
          subjectKind: "USER",
          rank: { gte: tier.rankMin, lte: tier.rankMax },
        },
      });

      for (const snap of snaps) {
        const key = `season_payout:${seasonId}:${tier.metric}:${snap.subjectId}:${tier.rankMin}:${tier.rankMax}`;
        const exists = await tx.userPointTransaction.findFirst({
          where: { userId: snap.subjectId, idempotencyKey: key },
        });
        if (exists || tier.spAmount <= 0) {
          continue;
        }

        const now = new Date();
        const expiresAt = new Date(now);
        expiresAt.setUTCDate(expiresAt.getUTCDate() + expirationDays);

        await tx.userPointTransaction.create({
          data: {
            id: randomUUID(),
            userId: snap.subjectId,
            kind: "SP",
            amount: tier.spAmount,
            sourceType: "SEASON_END",
            sourceId: seasonId,
            seasonId: null,
            metadata: {
              metric: tier.metric,
              rank: snap.rank,
              tierRankMin: tier.rankMin,
              tierRankMax: tier.rankMax,
            } as Prisma.InputJsonValue,
            idempotencyKey: key,
          },
        });

        await tx.userSpWalletEntry.create({
          data: {
            id: randomUUID(),
            userId: snap.subjectId,
            amount: tier.spAmount,
            remaining: tier.spAmount,
            sourceType: "SEASON_END",
            sourceId: seasonId,
            expiresAt,
          },
        });
      }
    }
  }

  /**
   * Close a FROZEN season and open the next ACTIVE window using schedule metadata defaults (duration heuristic).
   */
  async closeAndOpenNext(
    closedSeasonId: string,
    body?: { nextLabel?: string | null },
  ): Promise<{ closed: SeasonResponse; next: SeasonResponse }> {
    return prisma.$transaction(async (tx) => {
      const closed = await tx.season.findUnique({ where: { id: closedSeasonId } });
      if (!closed) {
        throw new Error("SEASON_NOT_FOUND");
      }
      if (closed.status !== "FROZEN") {
        throw new Error("SEASON_NOT_FROZEN");
      }

      await tx.season.update({
        where: { id: closedSeasonId },
        data: { status: "CLOSED" },
      });

      const schedule = await tx.seasonScheduleRules.findUnique({
        where: { kind: closed.kind },
      });

      const prevEnd = closed.endsAt;
      const startsAt = new Date(prevEnd);
      startsAt.setMilliseconds(startsAt.getMilliseconds() + 1);

      let endsAt = new Date(startsAt);
      if (closed.kind === "MONTHLY") {
        endsAt.setUTCMonth(endsAt.getUTCMonth() + 1);
      } else {
        endsAt.setUTCMonth(endsAt.getUTCMonth() + 3);
      }

      const next = await tx.season.create({
        data: {
          id: randomUUID(),
          label: body?.nextLabel ?? `${closed.kind} ${startsAt.toISOString().slice(0, 10)}`,
          kind: closed.kind,
          status: "ACTIVE",
          startsAt,
          endsAt,
        },
      });

      if (schedule && !schedule.autoRotate) {
        // noop — metadata only
      }

      return {
        closed: toSeasonResponse(
          await tx.season.findUniqueOrThrow({ where: { id: closedSeasonId } }),
        ),
        next: toSeasonResponse(next),
      };
    });
  }
}

export const seasonService = new SeasonService();
