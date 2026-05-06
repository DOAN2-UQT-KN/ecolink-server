import type { BadgeCategory, BadgeScope, Prisma } from "@prisma/client";

export const BADGE_CATEGORIES: BadgeCategory[] = [
  "REPORT",
  "CAMPAIGN",
  "CONTRIBUTION",
  "RANK",
];
export const BADGE_SCOPES: BadgeScope[] = ["LIFETIME", "SEASON"];

export function parseBadgeCategory(raw: string): BadgeCategory | null {
  const v = raw.trim().toUpperCase();
  return BADGE_CATEGORIES.includes(v as BadgeCategory)
    ? (v as BadgeCategory)
    : null;
}

export function parseBadgeScope(raw: string): BadgeScope | null {
  const v = raw.trim().toUpperCase();
  return BADGE_SCOPES.includes(v as BadgeScope) ? (v as BadgeScope) : null;
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
  category: BadgeCategory;
  scope: BadgeScope;
  isRepeatable: boolean;
  maxGrantsPerUser: number | null | undefined;
  cooldownSeconds: number;
  rulesConfig: Prisma.InputJsonValue | null | undefined;
}): string | null {
  const { category, scope, maxGrantsPerUser, cooldownSeconds, rulesConfig } =
    input;

  if (!BADGE_CATEGORIES.includes(category)) {
    return "invalid_category";
  }
  if (!BADGE_SCOPES.includes(scope)) {
    return "invalid_scope";
  }
  if (maxGrantsPerUser != null) {
    if (!Number.isInteger(maxGrantsPerUser) || maxGrantsPerUser <= 0) {
      return "max_grants_per_user_invalid";
    }
  }
  if (!Number.isFinite(cooldownSeconds)) {
    return "cooldown_seconds_invalid";
  }
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0) {
    return "cooldown_seconds_invalid";
  }
  if (rulesConfig != null) {
    if (typeof rulesConfig !== "object" || Array.isArray(rulesConfig)) {
      return "rules_config_must_be_object";
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
