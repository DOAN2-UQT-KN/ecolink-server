import type {
  BadgeRuleType,
  LeaderboardMetric,
  Prisma,
} from "@prisma/client";

export const BADGE_RULE_TYPES: BadgeRuleType[] = ["THRESHOLD", "RANK"];

export const LEADERBOARD_METRICS: LeaderboardMetric[] = [
  "CRP",
  "VRP",
  "ORG_AGGREGATE",
];

export function parseBadgeRuleType(raw: string): BadgeRuleType | null {
  const v = raw.trim().toUpperCase();
  return BADGE_RULE_TYPES.includes(v as BadgeRuleType)
    ? (v as BadgeRuleType)
    : null;
}

export function parseLeaderboardMetric(raw: string): LeaderboardMetric | null {
  const v = raw.trim().toUpperCase();
  return LEADERBOARD_METRICS.includes(v as LeaderboardMetric)
    ? (v as LeaderboardMetric)
    : null;
}

/** Lowercase snake_case from arbitrary admin input. */
export function normalizeSlugInput(raw: string): string {
  const s = raw
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return s.slice(0, 128);
}

/** Auto slug from display name. */
export function slugifyFromName(name: string): string {
  const base = normalizeSlugInput(name);
  return base.length > 0 ? base : "badge";
}

export function validateBadgeDefinitionShape(input: {
  ruleType: BadgeRuleType;
  metric: LeaderboardMetric;
  threshold: number | null | undefined;
  rankTopN: number | null | undefined;
}): string | null {
  const { ruleType, metric, threshold, rankTopN } = input;
  if (!LEADERBOARD_METRICS.includes(metric)) {
    return "invalid_metric";
  }
  if (!BADGE_RULE_TYPES.includes(ruleType)) {
    return "invalid_rule_type";
  }

  if (ruleType === "THRESHOLD") {
    if (threshold == null || !Number.isFinite(threshold)) {
      return "threshold_required";
    }
    if (!Number.isInteger(threshold) || threshold < 0) {
      return "threshold_invalid";
    }
    if (rankTopN != null) {
      return "rank_top_n_must_be_null_for_threshold";
    }
  } else {
    if (rankTopN == null || !Number.isFinite(rankTopN)) {
      return "rank_top_n_required";
    }
    if (!Number.isInteger(rankTopN) || rankTopN < 1) {
      return "rank_top_n_invalid";
    }
    if (threshold != null) {
      return "threshold_must_be_null_for_rank";
    }
  }
  return null;
}

type RewardObj = {
  discountBps?: unknown;
  discount_bps?: unknown;
  bonus_sp?: unknown;
  partner_tier_codes?: unknown;
  perks?: unknown;
};

/** Optional reward payload validation (non-null object). */
export function validateRewardJson(
  reward: Prisma.InputJsonValue | null | undefined,
): string | null {
  if (reward === undefined || reward === null) {
    return null;
  }
  if (typeof reward !== "object" || Array.isArray(reward)) {
    return "reward_must_be_object";
  }
  const o = reward as RewardObj;
  const allowed = new Set([
    "discountBps",
    "discount_bps",
    "bonus_sp",
    "partner_tier_codes",
    "perks",
  ]);
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) {
      return "reward_unknown_key";
    }
  }
  const bpsRaw = o.discountBps ?? o.discount_bps;
  if (bpsRaw !== undefined) {
    if (typeof bpsRaw !== "number" || !Number.isInteger(bpsRaw)) {
      return "reward_discount_bps_invalid";
    }
    if (bpsRaw < 0 || bpsRaw > 10000) {
      return "reward_discount_bps_range";
    }
  }
  if (o.bonus_sp !== undefined) {
    if (typeof o.bonus_sp !== "number" || !Number.isInteger(o.bonus_sp)) {
      return "reward_bonus_sp_invalid";
    }
    if (o.bonus_sp < 0) {
      return "reward_bonus_sp_range";
    }
  }
  if (o.partner_tier_codes !== undefined) {
    if (!Array.isArray(o.partner_tier_codes)) {
      return "reward_partner_tier_codes_invalid";
    }
    for (const c of o.partner_tier_codes) {
      if (typeof c !== "string" || !c.trim()) {
        return "reward_partner_tier_codes_invalid";
      }
    }
  }
  if (
    o.perks !== undefined &&
    (typeof o.perks !== "object" || o.perks === null || Array.isArray(o.perks))
  ) {
    return "reward_perks_invalid";
  }
  return null;
}
