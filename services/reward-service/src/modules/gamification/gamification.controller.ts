import type { Request, Response } from "express";
import type { LeaderboardMetric, SeasonKind } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  HTTP_STATUS,
  sendError,
  sendSuccess,
} from "../../constants/http-status";
import {
  parseBadgeRuleType,
  parseLeaderboardMetric,
} from "./badge-definition.validation";
import { badgeService } from "./badge.service";
import { campaignRewardDisplayService } from "./campaign-reward-display.service";
import { gamificationConfigService } from "./gamification-config.service";
import type { PublicMetric } from "./gamification-leaderboard.service";
import { gamificationLeaderboardService } from "./gamification-leaderboard.service";
import { gamificationSummaryService } from "./gamification-summary.service";
import { seasonService } from "./season.service";

function parseMetric(param: string): PublicMetric | null {
  const m = param.toUpperCase();
  if (m === "CRP" || m === "VRP" || m === "ORG_AGGREGATE") {
    return m;
  }
  return null;
}

export async function getSeasonCurrent(_req: Request, res: Response): Promise<void> {
  try {
    const season = await seasonService.getCurrentSeason();
    sendSuccess(res, HTTP_STATUS.OK, { season });
  } catch (e) {
    console.error("getSeasonCurrent", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getSeasonById(req: Request, res: Response): Promise<void> {
  try {
    const row = await seasonService.getById(req.params.id as string);
    if (!row) {
      sendError(res, HTTP_STATUS.NOT_FOUND.withMessage("Season not found"));
      return;
    }
    sendSuccess(res, HTTP_STATUS.OK, { season: row });
  } catch (e) {
    console.error("getSeasonById", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getGamificationSummary(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    sendError(res, HTTP_STATUS.UNAUTHORIZED);
    return;
  }
  try {
    const summary = await gamificationSummaryService.getSummaryForUser(userId);
    sendSuccess(res, HTTP_STATUS.OK, summary);
  } catch (e) {
    console.error("getGamificationSummary", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getMyPointTransactions(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    sendError(res, HTTP_STATUS.UNAUTHORIZED);
    return;
  }
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  try {
    const data = await gamificationSummaryService.listPointTransactions(
      userId,
      page,
      limit,
      kind,
    );
    const totalPages =
      data.total === 0 ? 0 : Math.ceil(data.total / data.limit);
    sendSuccess(res, HTTP_STATUS.OK, { ...data, totalPages });
  } catch (e) {
    console.error("getMyPointTransactions", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getPointsBySeason(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    sendError(res, HTTP_STATUS.UNAUTHORIZED);
    return;
  }
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  try {
    const data = await gamificationSummaryService.getPointsBySeason(
      userId,
      page,
      limit,
    );
    const totalPages =
      data.total === 0 ? 0 : Math.ceil(data.total / data.limit);
    sendSuccess(res, HTTP_STATUS.OK, { ...data, totalPages });
  } catch (e) {
    console.error("getPointsBySeason", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getMyBadges(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    sendError(res, HTTP_STATUS.UNAUTHORIZED);
    return;
  }
  const seasonId =
    typeof req.query.seasonId === "string" ? req.query.seasonId : undefined;
  try {
    const badges = await badgeService.listMyBadges(userId, seasonId);
    sendSuccess(res, HTTP_STATUS.OK, { badges });
  } catch (e) {
    console.error("getMyBadges", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getCampaignRewardEstimate(
  req: Request,
  res: Response,
): Promise<void> {
  const level = Number(req.query.difficultyLevel);
  if (!Number.isInteger(level) || level < 1) {
    sendError(
      res,
      HTTP_STATUS.VALIDATION_ERROR.withMessage(
        "difficultyLevel must be a positive integer",
      ),
    );
    return;
  }
  try {
    const estimate =
      await campaignRewardDisplayService.getEstimateForDifficultyLevel(level);
    if (!estimate) {
      sendError(res, HTTP_STATUS.NOT_FOUND.withMessage("Difficulty not found"));
      return;
    }
    sendSuccess(res, HTTP_STATUS.OK, estimate);
  } catch (e) {
    console.error("getCampaignRewardEstimate", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getGamificationLeaderboard(
  req: Request,
  res: Response,
): Promise<void> {
  const metric = parseMetric(req.params.metric as string);
  if (!metric) {
    sendError(
      res,
      HTTP_STATUS.VALIDATION_ERROR.withMessage(
        "metric must be crp, vrp, or org_aggregate",
      ),
    );
    return;
  }
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  const seasonId =
    typeof req.query.seasonId === "string" ? req.query.seasonId : undefined;
  try {
    const { rows, total, seasonId: sid } =
      await gamificationLeaderboardService.getLeaderboard(
        metric,
        page,
        limit,
        seasonId,
      );
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    sendSuccess(res, HTTP_STATUS.OK, {
      metric,
      seasonId: sid,
      leaderboard: rows,
      page,
      limit,
      total,
      totalPages,
    });
  } catch (e) {
    console.error("getGamificationLeaderboard", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getGamificationLeaderboardMe(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    sendError(res, HTTP_STATUS.UNAUTHORIZED);
    return;
  }
  const metric = parseMetric(req.params.metric as string);
  if (!metric) {
    sendError(
      res,
      HTTP_STATUS.VALIDATION_ERROR.withMessage(
        "metric must be crp, vrp, or org_aggregate",
      ),
    );
    return;
  }
  if (metric === "ORG_AGGREGATE") {
    sendSuccess(res, HTTP_STATUS.OK, { leaderboardMe: null });
    return;
  }
  const seasonId =
    typeof req.query.seasonId === "string" ? req.query.seasonId : undefined;
  try {
    const leaderboardMe =
      await gamificationLeaderboardService.getLeaderboardMe(
        userId,
        metric,
        seasonId,
      );
    sendSuccess(res, HTTP_STATUS.OK, { leaderboardMe });
  } catch (e) {
    console.error("getGamificationLeaderboardMe", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// --- Admin ---

export async function adminGetPointRules(_req: Request, res: Response): Promise<void> {
  try {
    const rules = await gamificationConfigService.getActivePointRules();
    sendSuccess(res, HTTP_STATUS.OK, { rules });
  } catch (e) {
    console.error("adminGetPointRules", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminPatchPointRules(req: Request, res: Response): Promise<void> {
  try {
    const baseReportPoint = Number(req.body.baseReportPoint);
    const raw = req.body.reportMilestoneThresholds;
    if (!Number.isInteger(baseReportPoint) || baseReportPoint < 0) {
      sendError(
        res,
        HTTP_STATUS.VALIDATION_ERROR.withMessage("Invalid baseReportPoint"),
      );
      return;
    }
    if (!Array.isArray(raw) || !raw.every((x) => Number.isInteger(x))) {
      sendError(
        res,
        HTTP_STATUS.VALIDATION_ERROR.withMessage(
          "reportMilestoneThresholds must be integer array",
        ),
      );
      return;
    }
    const rules = await gamificationConfigService.upsertPointRules({
      baseReportPoint,
      reportMilestoneThresholds: raw as number[],
      volunteerBonusCapByDifficulty: req.body.volunteerBonusCapByDifficulty as
        | Prisma.InputJsonValue
        | undefined,
    });
    sendSuccess(res, HTTP_STATUS.OK, { rules });
  } catch (e) {
    console.error("adminPatchPointRules", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminGetSpRules(_req: Request, res: Response): Promise<void> {
  try {
    const rules = await gamificationConfigService.getActiveSpRules();
    sendSuccess(res, HTTP_STATUS.OK, { rules });
  } catch (e) {
    console.error("adminGetSpRules", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminPatchSpRules(req: Request, res: Response): Promise<void> {
  try {
    const expirationDays = Number(req.body.expirationDays);
    if (!Number.isInteger(expirationDays) || expirationDays < 1) {
      sendError(
        res,
        HTTP_STATUS.VALIDATION_ERROR.withMessage("Invalid expirationDays"),
      );
      return;
    }
    const rules = await gamificationConfigService.upsertSpRules({
      expirationDays,
    });
    sendSuccess(res, HTTP_STATUS.OK, { rules });
  } catch (e) {
    console.error("adminPatchSpRules", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminListMultipliers(_req: Request, res: Response): Promise<void> {
  try {
    const multipliers = await gamificationConfigService.listMultiplierRules();
    sendSuccess(res, HTTP_STATUS.OK, { multipliers });
  } catch (e) {
    console.error("adminListMultipliers", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminPutMultiplier(req: Request, res: Response): Promise<void> {
  try {
    const code = String(req.body.code ?? "").trim();
    if (!code) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR.withMessage("code required"));
      return;
    }
    const row = await gamificationConfigService.upsertMultiplierRule({
      code,
      multiplier: req.body.multiplier as number | string,
      priority:
        req.body.priority !== undefined ? Number(req.body.priority) : undefined,
      isActive:
        req.body.isActive !== undefined ? Boolean(req.body.isActive) : undefined,
    });
    sendSuccess(res, HTTP_STATUS.OK, { multiplier: row });
  } catch (e) {
    console.error("adminPutMultiplier", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminListSeasonSchedules(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const schedules = await gamificationConfigService.listSeasonScheduleRules();
    sendSuccess(res, HTTP_STATUS.OK, { schedules });
  } catch (e) {
    console.error("adminListSeasonSchedules", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminPutSeasonSchedule(req: Request, res: Response): Promise<void> {
  try {
    const kind = String(req.body.kind ?? "").toUpperCase();
    if (kind !== "MONTHLY" && kind !== "QUARTERLY") {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR.withMessage("Invalid kind"));
      return;
    }
    const row = await gamificationConfigService.upsertSeasonScheduleRule({
      kind: kind as SeasonKind,
      autoRotate:
        req.body.autoRotate !== undefined ? Boolean(req.body.autoRotate) : undefined,
      metadata:
        req.body.metadata === null || req.body.metadata === undefined
          ? req.body.metadata
          : (req.body.metadata as Prisma.InputJsonValue),
    });
    sendSuccess(res, HTTP_STATUS.OK, { schedule: row });
  } catch (e) {
    console.error("adminPutSeasonSchedule", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminListPayoutTiers(req: Request, res: Response): Promise<void> {
  try {
    const seasonId =
      typeof req.query.seasonId === "string" ? req.query.seasonId : undefined;
    const tiers = await gamificationConfigService.listPayoutTiers(seasonId);
    sendSuccess(res, HTTP_STATUS.OK, { tiers });
  } catch (e) {
    console.error("adminListPayoutTiers", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminCreatePayoutTier(req: Request, res: Response): Promise<void> {
  try {
    const metric = String(req.body.metric ?? "").toUpperCase();
    if (!["CRP", "VRP", "ORG_AGGREGATE"].includes(metric)) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR.withMessage("Invalid metric"));
      return;
    }
    const rankMin = Number(req.body.rankMin);
    const rankMax = Number(req.body.rankMax);
    const spAmount = Number(req.body.spAmount);
    if (
      !Number.isInteger(rankMin) ||
      !Number.isInteger(rankMax) ||
      rankMin < 1 ||
      rankMax < rankMin ||
      !Number.isInteger(spAmount) ||
      spAmount < 0
    ) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR.withMessage("Invalid tier bounds"));
      return;
    }
    const tier = await gamificationConfigService.createPayoutTier({
      seasonId:
        typeof req.body.seasonId === "string" ? req.body.seasonId : null,
      metric: metric as LeaderboardMetric,
      rankMin,
      rankMax,
      spAmount,
    });
    sendSuccess(res, HTTP_STATUS.CREATED, { tier });
  } catch (e) {
    console.error("adminCreatePayoutTier", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminPatchPayoutTier(req: Request, res: Response): Promise<void> {
  try {
    const patch: {
      seasonId?: string | null;
      metric?: LeaderboardMetric;
      rankMin?: number;
      rankMax?: number;
      spAmount?: number;
    } = {};
    if (req.body.seasonId !== undefined) {
      patch.seasonId = req.body.seasonId as string | null;
    }
    if (req.body.metric !== undefined) {
      patch.metric = String(req.body.metric).toUpperCase() as LeaderboardMetric;
    }
    if (req.body.rankMin !== undefined) {
      patch.rankMin = Number(req.body.rankMin);
    }
    if (req.body.rankMax !== undefined) {
      patch.rankMax = Number(req.body.rankMax);
    }
    if (req.body.spAmount !== undefined) {
      patch.spAmount = Number(req.body.spAmount);
    }
    const tier = await gamificationConfigService.patchPayoutTier(
      req.params.id as string,
      patch,
    );
    if (!tier) {
      sendError(res, HTTP_STATUS.NOT_FOUND);
      return;
    }
    sendSuccess(res, HTTP_STATUS.OK, { tier });
  } catch (e) {
    console.error("adminPatchPayoutTier", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminDeletePayoutTier(req: Request, res: Response): Promise<void> {
  try {
    const ok = await gamificationConfigService.deletePayoutTier(
      req.params.id as string,
    );
    if (!ok) {
      sendError(res, HTTP_STATUS.NOT_FOUND);
      return;
    }
    sendSuccess(res, HTTP_STATUS.OK, { deleted: true });
  } catch (e) {
    console.error("adminDeletePayoutTier", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminListBadges(req: Request, res: Response): Promise<void> {
  try {
    const includeInactive = req.query.includeInactive === "true";
    const badges = await badgeService.listDefinitionsAdmin(includeInactive);
    sendSuccess(res, HTTP_STATUS.OK, { badges });
  } catch (e) {
    console.error("adminListBadges", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminCreateBadge(req: Request, res: Response): Promise<void> {
  try {
    const slugRaw =
      req.body.slug !== undefined && req.body.slug !== null
        ? String(req.body.slug).trim()
        : "";
    const name = String(req.body.name ?? "").trim();
    const ruleType = parseBadgeRuleType(String(req.body.ruleType ?? ""));
    const metric = parseLeaderboardMetric(String(req.body.metric ?? ""));
    if (!name || !ruleType || !metric) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR);
      return;
    }
    let symbol: string | null | undefined = undefined;
    if (req.body.symbol !== undefined) {
      symbol =
        req.body.symbol === null
          ? null
          : String(req.body.symbol).trim() || null;
    }

    let publishedAt: Date | null | undefined = undefined;
    if (req.body.publishedAt !== undefined) {
      if (req.body.publishedAt === null || req.body.publishedAt === "") {
        publishedAt = null;
      } else {
        const d = new Date(String(req.body.publishedAt));
        if (Number.isNaN(d.getTime())) {
          sendError(res, HTTP_STATUS.VALIDATION_ERROR);
          return;
        }
        publishedAt = d;
      }
    }

    const badge = await badgeService.createDefinition({
      slug: slugRaw.length > 0 ? slugRaw : null,
      name,
      symbol,
      ruleType,
      metric,
      threshold:
        req.body.threshold !== undefined && req.body.threshold !== null
          ? Number(req.body.threshold)
          : null,
      rankTopN:
        req.body.rankTopN !== undefined && req.body.rankTopN !== null
          ? Number(req.body.rankTopN)
          : null,
      reward:
        req.body.reward === undefined
          ? undefined
          : req.body.reward === null
            ? null
            : (req.body.reward as Prisma.InputJsonValue),
      isActive:
        req.body.isActive !== undefined ? Boolean(req.body.isActive) : undefined,
      publishedAt,
    });
    sendSuccess(res, HTTP_STATUS.CREATED, { badge });
  } catch (e) {
    if (
      e instanceof Error &&
      (e.message.startsWith("badge_validation:") ||
        e.message === "badge_slug_empty" ||
        e.message === "badge_slug_exhausted")
    ) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR);
      return;
    }
    console.error("adminCreateBadge", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminPatchBadge(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body;
    const patch: Parameters<typeof badgeService.patchDefinition>[1] = {};
    if (body.name !== undefined) {
      patch.name = String(body.name).trim();
    }
    if (body.symbol !== undefined) {
      patch.symbol =
        body.symbol === null
          ? null
          : String(body.symbol).trim() || null;
    }
    if (body.ruleType !== undefined) {
      const rt = parseBadgeRuleType(String(body.ruleType));
      if (!rt) {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR);
        return;
      }
      patch.ruleType = rt;
    }
    if (body.metric !== undefined) {
      const m = parseLeaderboardMetric(String(body.metric));
      if (!m) {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR);
        return;
      }
      patch.metric = m;
    }
    if (body.threshold !== undefined) {
      patch.threshold =
        body.threshold === null ? null : Number(body.threshold);
    }
    if (body.rankTopN !== undefined) {
      patch.rankTopN =
        body.rankTopN === null ? null : Number(body.rankTopN);
    }
    if (body.reward !== undefined) {
      patch.reward =
        body.reward === null
          ? null
          : (body.reward as Prisma.InputJsonValue);
    }
    if (body.isActive !== undefined) {
      patch.isActive = Boolean(body.isActive);
    }
    if (body.deletedAt !== undefined) {
      patch.deletedAt =
        body.deletedAt === null ? null : new Date(String(body.deletedAt));
    }
    if (body.publishedAt !== undefined && body.publishedAt !== null) {
      const raw = String(body.publishedAt).trim();
      if (!raw) {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR);
        return;
      }
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR);
        return;
      }
      patch.publishedAt = d;
    }

    const badge = await badgeService.patchDefinition(req.params.id as string, patch);
    if (!badge) {
      sendError(res, HTTP_STATUS.NOT_FOUND);
      return;
    }
    sendSuccess(res, HTTP_STATUS.OK, { badge });
  } catch (e) {
    if (
      e instanceof Error &&
      e.message.startsWith("badge_validation:")
    ) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR);
      return;
    }
    console.error("adminPatchBadge", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminListSeasons(req: Request, res: Response): Promise<void> {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const data = await seasonService.listAdmin(page, limit);
    const totalPages = data.total === 0 ? 0 : Math.ceil(data.total / limit);
    sendSuccess(res, HTTP_STATUS.OK, { ...data, totalPages });
  } catch (e) {
    console.error("adminListSeasons", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminCreateSeason(req: Request, res: Response): Promise<void> {
  try {
    const kind = String(req.body.kind ?? "").toUpperCase();
    if (kind !== "MONTHLY" && kind !== "QUARTERLY") {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR.withMessage("Invalid kind"));
      return;
    }
    const startsAt = new Date(String(req.body.startsAt ?? ""));
    const endsAt = new Date(String(req.body.endsAt ?? ""));
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR.withMessage("Invalid dates"));
      return;
    }
    const season = await seasonService.createSeason({
      label:
        req.body.label !== undefined ? String(req.body.label) : null,
      kind: kind as SeasonKind,
      startsAt,
      endsAt,
      status:
        req.body.status !== undefined
          ? (String(req.body.status).toUpperCase() as import("@prisma/client").SeasonStatus)
          : undefined,
    });
    sendSuccess(res, HTTP_STATUS.CREATED, { season });
  } catch (e) {
    console.error("adminCreateSeason", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminPatchSeason(req: Request, res: Response): Promise<void> {
  try {
    const patch: Parameters<typeof seasonService.patchSeason>[1] = {};
    if (req.body.label !== undefined) {
      patch.label =
        req.body.label === null ? null : String(req.body.label);
    }
    if (req.body.startsAt !== undefined) {
      patch.startsAt = new Date(String(req.body.startsAt));
    }
    if (req.body.endsAt !== undefined) {
      patch.endsAt = new Date(String(req.body.endsAt));
    }
    if (req.body.status !== undefined) {
      patch.status = String(req.body.status).toUpperCase() as import("@prisma/client").SeasonStatus;
    }
    if (req.body.kind !== undefined) {
      patch.kind = String(req.body.kind).toUpperCase() as SeasonKind;
    }

    const season = await seasonService.patchSeason(req.params.id as string, patch);
    if (!season) {
      sendError(res, HTTP_STATUS.NOT_FOUND);
      return;
    }
    sendSuccess(res, HTTP_STATUS.OK, { season });
  } catch (e) {
    console.error("adminPatchSeason", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminFreezeSeason(req: Request, res: Response): Promise<void> {
  try {
    const result = await seasonService.freezeSeason(req.params.id as string);
    sendSuccess(res, HTTP_STATUS.OK, result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "SEASON_NOT_FOUND") {
      sendError(res, HTTP_STATUS.NOT_FOUND.withMessage("Season not found"));
      return;
    }
    if (msg === "SEASON_NOT_ACTIVE") {
      sendError(
        res,
        HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage("Season is not ACTIVE"),
      );
      return;
    }
    console.error("adminFreezeSeason", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminCloseSeasonAndOpenNext(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const nextLabel =
      req.body.nextLabel !== undefined
        ? String(req.body.nextLabel)
        : undefined;
    const result = await seasonService.closeAndOpenNext(req.params.id as string, {
      nextLabel,
    });
    sendSuccess(res, HTTP_STATUS.OK, result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "SEASON_NOT_FOUND") {
      sendError(res, HTTP_STATUS.NOT_FOUND);
      return;
    }
    if (msg === "SEASON_NOT_FROZEN") {
      sendError(
        res,
        HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage("Season must be FROZEN"),
      );
      return;
    }
    console.error("adminCloseSeasonAndOpenNext", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}
