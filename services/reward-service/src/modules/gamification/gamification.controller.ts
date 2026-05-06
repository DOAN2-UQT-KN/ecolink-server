import type { Request, Response } from "express";
import type { LeaderboardMetric, SeasonKind } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  HTTP_STATUS,
  sendError,
  sendSuccess,
} from "../../constants/http-status";
import {
  parseBadgeCategory,
  parseBadgeScope,
} from "./badge-definition.validation";
import { badgeService } from "./badge.service";
import { campaignRewardDisplayService } from "./campaign-reward-display.service";
import { gamificationConfigService } from "./gamification-config.service";
import type { PublicMetric } from "./gamification-leaderboard.service";
import { gamificationLeaderboardService } from "./gamification-leaderboard.service";
import { gamificationSummaryService } from "./gamification-summary.service";
import { seasonService } from "./season.service";

type SeasonStatusValue = "ACTIVE" | "INACTIVE";
type BadgeRuleTypeValue = "THRESHOLD" | "RANK";
type BadgeMetricValue = "CRP" | "VRP" | "ORG_AGGREGATE";

function parseSeasonStatus(value: unknown): SeasonStatusValue | null {
  if (value === undefined || value === null) {
    return null;
  }
  const raw = String(value).trim().toUpperCase();
  if (raw === "ACTIVE") {
    return "ACTIVE";
  }
  if (raw === "INACTIVE") {
    return "INACTIVE";
  }
  return null;
}

function parseBadgeRuleTypeValue(value: unknown): BadgeRuleTypeValue | null {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase();
  if (raw === "THRESHOLD" || raw === "RANK") {
    return raw;
  }
  return null;
}

function parseBadgeMetricValue(value: unknown): BadgeMetricValue | null {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase();
  if (raw === "CRP" || raw === "VRP" || raw === "ORG_AGGREGATE") {
    return raw;
  }
  return null;
}

function parseNullableInt(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) {
    return "invalid";
  }
  return n;
}

function parseNonNegativeInt(value: unknown): number | "invalid" {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return "invalid";
  }
  return n;
}

function parsePositiveIntOrNull(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return "invalid";
  }
  return n;
}

function parseRulesConfigFromBody(
  raw: unknown,
): Prisma.InputJsonValue | null | undefined | "invalid" {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return "invalid";
  }
  return raw as Prisma.InputJsonValue;
}

function buildLegacyRulesConfig(
  ruleType: BadgeRuleTypeValue,
  metric: BadgeMetricValue,
  threshold: number | null,
  rankTopN: number | null,
): Prisma.InputJsonValue {
  const operator = ruleType === "RANK" ? "lte" : "gte";
  const value = ruleType === "RANK" ? (rankTopN as number) : (threshold as number);
  return {
    logical_operator: "AND",
    conditions: [
      {
        target: "user_point_transactions",
        agg: "SUM",
        field: "amount",
        operator,
        value,
        metric,
        ruleType,
      },
    ],
  } as Prisma.InputJsonValue;
}
function parseMetric(param: string): PublicMetric | null {
  const m = param.toUpperCase();
  if (m === "CRP" || m === "VRP" || m === "ORG_AGGREGATE") {
    return m;
  }
  return null;
}

export async function getSeasonCurrent(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const season = await seasonService.getCurrentSeason();
    sendSuccess(res, HTTP_STATUS.OK, { season });
  } catch (e) {
    console.error("getSeasonCurrent", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getSeasonById(
  req: Request,
  res: Response,
): Promise<void> {
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

export async function getPointsBySeason(
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
    const {
      rows,
      total,
      seasonId: sid,
    } = await gamificationLeaderboardService.getLeaderboard(
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
    const leaderboardMe = await gamificationLeaderboardService.getLeaderboardMe(
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

export async function adminGetPointRules(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const rules = await gamificationConfigService.getActivePointRules();
    sendSuccess(res, HTTP_STATUS.OK, { rules });
  } catch (e) {
    console.error("adminGetPointRules", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminPatchPointRules(
  req: Request,
  res: Response,
): Promise<void> {
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

export async function adminGetSpRules(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const rules = await gamificationConfigService.getActiveSpRules();
    sendSuccess(res, HTTP_STATUS.OK, { rules });
  } catch (e) {
    console.error("adminGetSpRules", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminPatchSpRules(
  req: Request,
  res: Response,
): Promise<void> {
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

export async function adminListMultipliers(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const multipliers = await gamificationConfigService.listMultiplierRules();
    sendSuccess(res, HTTP_STATUS.OK, { multipliers });
  } catch (e) {
    console.error("adminListMultipliers", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminPutMultiplier(
  req: Request,
  res: Response,
): Promise<void> {
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
        req.body.isActive !== undefined
          ? Boolean(req.body.isActive)
          : undefined,
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

export async function adminPutSeasonSchedule(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const kind = String(req.body.kind ?? "").toUpperCase();
    if (kind !== "MONTHLY" && kind !== "QUARTERLY") {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR.withMessage("Invalid kind"));
      return;
    }
    const row = await gamificationConfigService.upsertSeasonScheduleRule({
      kind: kind as SeasonKind,
      autoRotate:
        req.body.autoRotate !== undefined
          ? Boolean(req.body.autoRotate)
          : undefined,
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

export async function adminListPayoutTiers(
  req: Request,
  res: Response,
): Promise<void> {
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

export async function adminCreatePayoutTier(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const metric = String(req.body.metric ?? "").toUpperCase();
    if (!["CRP", "VRP", "ORG_AGGREGATE"].includes(metric)) {
      sendError(
        res,
        HTTP_STATUS.VALIDATION_ERROR.withMessage("Invalid metric"),
      );
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
      sendError(
        res,
        HTTP_STATUS.VALIDATION_ERROR.withMessage("Invalid tier bounds"),
      );
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

export async function adminPatchPayoutTier(
  req: Request,
  res: Response,
): Promise<void> {
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

export async function adminDeletePayoutTier(
  req: Request,
  res: Response,
): Promise<void> {
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

export async function adminListBadges(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const includeInactive = req.query.includeInactive === "true";
    const badges = await badgeService.listDefinitionsAdmin(includeInactive);
    sendSuccess(res, HTTP_STATUS.OK, { badges });
  } catch (e) {
    console.error("adminListBadges", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminCreateBadge(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const slugRaw =
      req.body.slug !== undefined && req.body.slug !== null
        ? String(req.body.slug).trim()
        : "";
    const name = String(req.body.name ?? "").trim();
    const category = parseBadgeCategory(String(req.body.category ?? ""));
    if (!name || !category) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR);
      return;
    }

    let scope =
      req.body.scope !== undefined && req.body.scope !== null && req.body.scope !== ""
        ? parseBadgeScope(String(req.body.scope))
        : undefined;
    if (scope === null) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR);
      return;
    }

    let rulesConfigParsed = parseRulesConfigFromBody(req.body.rulesConfig);
    if (rulesConfigParsed === "invalid") {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR);
      return;
    }

    if (rulesConfigParsed === undefined) {
      const ruleType = parseBadgeRuleTypeValue(req.body.ruleType);
      const metric = parseBadgeMetricValue(req.body.metric);
      const threshold = parseNullableInt(req.body.threshold);
      const rankTopN = parseNullableInt(req.body.rankTopN);
      if (!ruleType || !metric) {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR);
        return;
      }
      if (
        threshold === "invalid" ||
        rankTopN === "invalid" ||
        (threshold !== null && threshold < 0) ||
        (rankTopN !== null && rankTopN < 1) ||
        (ruleType === "THRESHOLD" && threshold === null) ||
        (ruleType === "RANK" && rankTopN === null)
      ) {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR);
        return;
      }
      rulesConfigParsed = buildLegacyRulesConfig(
        ruleType,
        metric,
        threshold,
        rankTopN,
      );
      scope ??= "SEASON";
    }

    let isRepeatable: boolean | undefined = undefined;
    if (req.body.isRepeatable !== undefined) {
      isRepeatable = Boolean(req.body.isRepeatable);
    }

    let cooldownSeconds: number | undefined = undefined;
    if (req.body.cooldownSeconds !== undefined && req.body.cooldownSeconds !== "") {
      const cd = parseNonNegativeInt(req.body.cooldownSeconds);
      if (cd === "invalid") {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR);
        return;
      }
      cooldownSeconds = cd;
    }

    let maxGrantsPerUser: number | null | undefined = undefined;
    if (req.body.maxGrantsPerUser !== undefined) {
      const mx = parsePositiveIntOrNull(req.body.maxGrantsPerUser);
      if (mx === "invalid") {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR);
        return;
      }
      maxGrantsPerUser = mx;
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
      category,
      ...(scope !== undefined ? { scope } : {}),
      ...(isRepeatable !== undefined ? { isRepeatable } : {}),
      ...(cooldownSeconds !== undefined ? { cooldownSeconds } : {}),
      ...(maxGrantsPerUser !== undefined ? { maxGrantsPerUser } : {}),
      rulesConfig: rulesConfigParsed,
      reward:
        req.body.reward === undefined
          ? undefined
          : req.body.reward === null
            ? null
            : (req.body.reward as Prisma.InputJsonValue),
      isActive:
        req.body.isActive !== undefined
          ? Boolean(req.body.isActive)
          : undefined,
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

export async function adminPatchBadge(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body;
    const patch: Parameters<typeof badgeService.patchDefinition>[1] = {};
    if (body.name !== undefined) {
      patch.name = String(body.name).trim();
    }
    if (body.symbol !== undefined) {
      patch.symbol =
        body.symbol === null ? null : String(body.symbol).trim() || null;
    }
    if (body.category !== undefined) {
      const category = parseBadgeCategory(String(body.category));
      if (!category) {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR);
        return;
      }
      patch.category = category;
    }
    if (body.scope !== undefined) {
      const scope = parseBadgeScope(String(body.scope ?? ""));
      if (!scope) {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR);
        return;
      }
      patch.scope = scope;
    }
    if (body.isRepeatable !== undefined) {
      patch.isRepeatable = Boolean(body.isRepeatable);
    }
    if (body.cooldownSeconds !== undefined) {
      const cd = parseNonNegativeInt(body.cooldownSeconds);
      if (cd === "invalid") {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR);
        return;
      }
      patch.cooldownSeconds = cd;
    }
    if (body.maxGrantsPerUser !== undefined) {
      const mx = parsePositiveIntOrNull(body.maxGrantsPerUser);
      if (mx === "invalid") {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR);
        return;
      }
      patch.maxGrantsPerUser = mx;
    }

    if ("rulesConfig" in body) {
      const rc = parseRulesConfigFromBody(body.rulesConfig);
      if (rc === "invalid") {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR);
        return;
      }
      patch.rulesConfig = rc === null ? null : (rc as Prisma.InputJsonValue);
    } else if (
      body.ruleType !== undefined ||
      body.metric !== undefined ||
      body.threshold !== undefined ||
      body.rankTopN !== undefined
    ) {
      const rt = parseBadgeRuleTypeValue(body.ruleType);
      const m = parseBadgeMetricValue(body.metric);
      const threshold = parseNullableInt(body.threshold);
      const rankTopN = parseNullableInt(body.rankTopN);
      if (
        !rt ||
        !m ||
        threshold === "invalid" ||
        rankTopN === "invalid" ||
        (threshold !== null && threshold < 0) ||
        (rankTopN !== null && rankTopN < 1) ||
        (rt === "THRESHOLD" && threshold === null) ||
        (rt === "RANK" && rankTopN === null)
      ) {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR);
        return;
      }
      patch.rulesConfig = buildLegacyRulesConfig(rt, m, threshold, rankTopN);
    }
    if (body.reward !== undefined) {
      patch.reward =
        body.reward === null ? null : (body.reward as Prisma.InputJsonValue);
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

    const badge = await badgeService.patchDefinition(
      req.params.id as string,
      patch,
    );
    if (!badge) {
      sendError(res, HTTP_STATUS.NOT_FOUND);
      return;
    }
    sendSuccess(res, HTTP_STATUS.OK, { badge });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("badge_validation:")) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR);
      return;
    }
    console.error("adminPatchBadge", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminListSeasons(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const kind =
      typeof req.query.kind === "string"
        ? (req.query.kind as SeasonKind)
        : undefined;
    const search =
      typeof req.query.search === "string"
        ? req.query.search.trim()
        : undefined;
    const data = await seasonService.listAdmin(page, limit, {
      kind,
      search,
    });
    const totalPages = data.total === 0 ? 0 : Math.ceil(data.total / limit);
    sendSuccess(res, HTTP_STATUS.OK, { ...data, totalPages });
  } catch (e) {
    console.error("adminListSeasons", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminCreateSeason(
  req: Request,
  res: Response,
): Promise<void> {
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
      label: req.body.label !== undefined ? String(req.body.label) : null,
      kind: kind as SeasonKind,
      startsAt,
      endsAt,
      status:
        req.body.status !== undefined
          ? (String(req.body.status).toUpperCase() as SeasonStatusValue)
          : undefined,
    });
    sendSuccess(res, HTTP_STATUS.CREATED, { season });
  } catch (e) {
    console.error("adminCreateSeason", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminPatchSeason(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const patch: Parameters<typeof seasonService.patchSeason>[1] = {};
    if (req.body.label !== undefined) {
      patch.label = req.body.label === null ? null : String(req.body.label);
    }
    if (req.body.startsAt !== undefined) {
      patch.startsAt = new Date(String(req.body.startsAt));
    }
    if (req.body.endsAt !== undefined) {
      patch.endsAt = new Date(String(req.body.endsAt));
    }
    if (req.body.status !== undefined) {
      const parsedStatus = parseSeasonStatus(req.body.status);
      if (parsedStatus === null) {
        sendError(
          res,
          HTTP_STATUS.VALIDATION_ERROR.withMessage("Invalid status"),
        );
        return;
      }
      patch.status = parsedStatus;
    }
    if (req.body.kind !== undefined) {
      patch.kind = String(req.body.kind).toUpperCase() as SeasonKind;
    }

    const season = await seasonService.patchSeason(
      req.params.id as string,
      patch,
    );
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

export async function adminFinalizeSeason(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const openNextRaw = req.query.openNext;
    const openNext = typeof openNextRaw === "string" && openNextRaw === "true";
    const nextLabel =
      req.body.nextLabel !== undefined ? String(req.body.nextLabel) : undefined;
    const startsAt = req.body.startsAt
      ? new Date(String(req.body.startsAt))
      : undefined;
    const endsAt = req.body.endsAt
      ? new Date(String(req.body.endsAt))
      : undefined;

    if (openNext) {
      if (!startsAt || Number.isNaN(startsAt.getTime())) {
        sendError(
          res,
          HTTP_STATUS.VALIDATION_ERROR.withMessage(
            "startsAt is required when openNext=true",
          ),
        );
        return;
      }
      if (!endsAt || Number.isNaN(endsAt.getTime())) {
        sendError(
          res,
          HTTP_STATUS.VALIDATION_ERROR.withMessage(
            "endsAt is required when openNext=true",
          ),
        );
        return;
      }
      if (startsAt >= endsAt) {
        sendError(
          res,
          HTTP_STATUS.VALIDATION_ERROR.withMessage(
            "startsAt must be earlier than endsAt",
          ),
        );
        return;
      }
    }

    const result = await seasonService.finalizeSeason(req.params.id as string, {
      openNext,
      nextLabel,
      startsAt,
      endsAt,
    });
    sendSuccess(res, HTTP_STATUS.OK, result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "SEASON_NOT_FOUND") {
      sendError(res, HTTP_STATUS.NOT_FOUND.withMessage("Season not found"));
      return;
    }
    if (msg === "SEASON_NOT_FINALIZABLE") {
      sendError(
        res,
        HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage(
          "Season must be ACTIVE or INACTIVE",
        ),
      );
      return;
    }
    if (msg === "NEXT_DATES_REQUIRED") {
      sendError(
        res,
        HTTP_STATUS.VALIDATION_ERROR.withMessage(
          "startsAt and endsAt are required when openNext=true",
        ),
      );
      return;
    }
    if (msg === "INVALID_NEXT_DATES") {
      sendError(
        res,
        HTTP_STATUS.VALIDATION_ERROR.withMessage(
          "startsAt must be earlier than endsAt",
        ),
      );
      return;
    }
    if (msg === "ACTIVE_SEASON_EXISTS") {
      sendError(
        res,
        HTTP_STATUS.UNPROCESSABLE_ENTITY.withMessage(
          "Another ACTIVE season already exists",
        ),
      );
      return;
    }
    console.error("adminFinalizeSeason", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}
