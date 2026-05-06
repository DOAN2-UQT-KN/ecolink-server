/**
 * OpenAPI / TypeScript schemas for gamification endpoints (`sendSuccess` `data` shapes).
 */

export interface SeasonDto {
  id: string;
  label: string | null;
  kind: string;
  status: string;
  startsAt: string;
  endsAt: string;
}

/** GET /seasons/current */
export interface SeasonCurrentEnvelopeData {
  season: SeasonDto | null;
}

/** GET /seasons/:id */
export interface SeasonOneEnvelopeData {
  season: SeasonDto;
}

export interface RankingPointsDto {
  citizenRp: number;
  volunteerRp: number;
  totalRp: number;
}

export interface SpendablePointsDto {
  balance: number;
  nextExpiresAt: string | null;
}

/** GET /me/gamification/summary */
export interface GamificationSummaryEnvelopeData {
  season: SeasonDto | null;
  rankingPoints: RankingPointsDto;
  spendablePoints: SpendablePointsDto;
  legacyGreenPointsBalance: number;
}

export interface GamificationPointTransactionsQuery {
  page?: number;
  limit?: number;
  kind?: string;
}

export interface UserPointTransactionDto {
  id: string;
  kind: string;
  amount: number;
  sourceType: string;
  sourceId: string | null;
  seasonId: string | null;
  metadata?: Record<string, unknown> | null;
  idempotencyKey: string | null;
  createdAt: string;
}

/** GET /me/gamification/point-transactions */
export interface GamificationPointTransactionsEnvelopeData {
  transactions: UserPointTransactionDto[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PointsBySeasonQuery {
  page?: number;
  limit?: number;
}

export interface UserSeasonPointsRowDto {
  seasonId: string;
  label: string | null;
  kind: string;
  status: string;
  startsAt: string;
  endsAt: string;
  /** Citizen ranking points this season */
  crp: number;
  /** Volunteer ranking points this season */
  vrp: number;
  /** Net spendable points (ledger SP) during season window */
  sp: number;
}

/** GET /me/gamification/points-by-season */
export interface PointsBySeasonEnvelopeData {
  seasons: UserSeasonPointsRowDto[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface MyBadgesQuery {
  seasonId?: string;
}

/** Season summary on a badge grant (`GET /me/badges`); excludes startsAt/endsAt. */
export interface BadgeGrantSeasonDto {
  id: string;
  label: string | null;
  kind: string;
  status: string;
}

/**
 * Badge fields nested under each grant (`GET /me/badges`).
 * Omits admin-only flags (`isActive`, timestamps).
 */
export interface MyBadgeNestedDto {
  id: string;
  slug: string;
  name: string;
  symbol?: string | null;
  category: string;
  /** `LIFETIME` | `SEASON` */
  scope: string;
  isRepeatable: boolean;
  maxGrantsPerUser: number | null;
  cooldownSeconds: number;
  /**
   * Rules AST (`logical_operator` AND/OR, `conditions`: nested groups or leaves).
   * Each leaf: `target`, `agg`, `field`, `operator`, `value`.
   */
  rulesConfig?: Record<string, unknown> | null;
  reward?: Record<string, unknown> | null;
}

export interface BadgeGrantItemDto {
  id: string;
  grantedAt: string;
  metadata?: Record<string, unknown> | null;
  season: BadgeGrantSeasonDto | null;
  badge: MyBadgeNestedDto;
}

/** GET /me/badges */
export interface MyBadgesEnvelopeData {
  badges: BadgeGrantItemDto[];
}

export interface CampaignRewardEstimateQuery {
  difficultyLevel: number;
}

/** GET /gamification/campaign-reward-estimate */
export interface CampaignRewardEstimateEnvelopeData {
  difficultyLevel: number;
  basePoints: number;
  estimatedBonusMax: number;
  estimatedRange: {
    min: number;
    max: number;
  };
  difficultyName: string | null;
}

export interface GamificationLeaderboardQuery {
  page?: number;
  limit?: number;
  seasonId?: string;
  organizationId?: string;
}

export interface GamificationLeaderboardUserDto {
  id: string;
  name: string | null;
  avatar: string | null;
}

export interface GamificationLeaderboardRowUserDto {
  rank: number;
  score: number;
  userId: string;
  user: GamificationLeaderboardUserDto | null;
}

export interface GamificationLeaderboardRowOrgDto {
  rank: number;
  score: number;
  organizationId: string;
}

/** GET /gamification/leaderboards/:metric — rows vary by metric */
export interface GamificationLeaderboardEnvelopeData {
  metric: string;
  seasonId: string | null;
  leaderboard: (
    | GamificationLeaderboardRowUserDto
    | GamificationLeaderboardRowOrgDto
  )[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface LeaderboardMeGamificationDto {
  rank: number;
  score: number;
  seasonId: string;
}

/** GET /gamification/leaderboards/:metric/me */
export interface GamificationLeaderboardMeEnvelopeData {
  leaderboardMe: LeaderboardMeGamificationDto | null;
}

// --- Admin bodies ---

export interface PatchGamificationPointRulesBody {
  baseReportPoint: number;
  reportMilestoneThresholds: number[];
  volunteerBonusCapByDifficulty?: Record<string, number>;
}

export interface GamificationPointRulesOneEnvelopeData {
  rules: Record<string, unknown> | null;
}

export interface PatchSpendablePointRulesBody {
  expirationDays: number;
}

export interface SpendablePointRulesOneEnvelopeData {
  rules: Record<string, unknown> | null;
}

export interface PutVolunteerMultiplierBody {
  code: string;
  multiplier: number | string;
  priority?: number;
  isActive?: boolean;
}

export interface VolunteerMultipliersListEnvelopeData {
  multipliers: Record<string, unknown>[];
}

export interface VolunteerMultiplierOneEnvelopeData {
  multiplier: Record<string, unknown>;
}

export interface PutSeasonScheduleBody {
  kind: string;
  autoRotate?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface SeasonSchedulesListEnvelopeData {
  schedules: Record<string, unknown>[];
}

export interface SeasonScheduleOneEnvelopeData {
  schedule: Record<string, unknown>;
}

export interface AdminPayoutTiersQuery {
  seasonId?: string;
}

export interface CreateSeasonPayoutTierBody {
  seasonId?: string | null;
  metric: string;
  rankMin: number;
  rankMax: number;
  spAmount: number;
}

export interface PatchSeasonPayoutTierBody {
  seasonId?: string | null;
  metric?: string;
  rankMin?: number;
  rankMax?: number;
  spAmount?: number;
}

export interface PayoutTiersListEnvelopeData {
  tiers: Record<string, unknown>[];
}

export interface PayoutTierOneEnvelopeData {
  tier: Record<string, unknown>;
}

export interface DeletePayoutTierEnvelopeData {
  deleted: boolean;
}

export interface AdminBadgeDefinitionsQuery {
  includeInactive?: string;
}

/**
 * Full badge catalog row (`GET/PATCH/POST /admin/gamification/badges`).
 * Matches persisted definition including rules-engine metadata.
 */
export interface GamificationBadgeDefinitionDto {
  id: string;
  slug: string;
  name: string;
  symbol?: string | null;
  category: string;
  /** `LIFETIME` | `SEASON` */
  scope: string;
  isRepeatable: boolean;
  maxGrantsPerUser: number | null;
  cooldownSeconds: number;
  /**
   * Rules AST evaluated server-side (recursive AND/OR groups).
   * Leaf shape: `{ target, agg, field, operator, value }`.
   */
  rulesConfig?: Record<string, unknown> | null;
  reward?: Record<string, unknown> | null;
  isActive: boolean;
  publishedAt: string | null;
  slugLockedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateBadgeDefinitionBody {
  /** Omit or empty: derived from `name` (unique snake_case). */
  slug?: string;
  name: string;
  symbol?: string | null;
  category: string;
  /**
   * `LIFETIME` | `SEASON`. Defaults to `SEASON` when omitted.
   */
  scope?: string;
  /** Multiple grants per user when allowed by caps/cooldown. */
  isRepeatable?: boolean;
  /** Hard cap on how many times a user may earn this badge; omit for no cap. */
  maxGrantsPerUser?: number | null;
  /** Minimum seconds between repeat grants (0 = none). */
  cooldownSeconds?: number;
  /**
   * Rules AST (`logical_operator`, `conditions`). Targets include `orders`, `reviews`,
   * `reports`, `votes`, `user_point_transactions`.
   * When present, legacy threshold/rank fields are ignored.
   */
  rulesConfig?: Record<string, unknown> | null;
  /**
   * Legacy fallback when `rulesConfig` is omitted: THRESHOLD | RANK plus metric/threshold/rankTopN.
   */
  ruleType?: string;
  metric?: string;
  threshold?: number | null;
  rankTopN?: number | null;
  reward?: Record<string, unknown> | null;
  isActive?: boolean;
  /** ISO 8601 — sets publish time and locks slug. */
  publishedAt?: string | null;
}

export interface PatchBadgeDefinitionBody {
  name?: string;
  symbol?: string | null;
  category?: string;
  scope?: string;
  isRepeatable?: boolean;
  maxGrantsPerUser?: number | null;
  cooldownSeconds?: number;
  /**
   * Replace rules AST; send JSON `null` to clear stored rules.
   */
  rulesConfig?: Record<string, unknown> | null;
  /** Legacy: rebuild rules AST when `rulesConfig` key not sent. */
  ruleType?: string;
  metric?: string;
  threshold?: number | null;
  rankTopN?: number | null;
  reward?: Record<string, unknown> | null;
  isActive?: boolean;
  deletedAt?: string | null;
  publishedAt?: string;
}

export interface BadgeDefinitionsListEnvelopeData {
  badges: GamificationBadgeDefinitionDto[];
}

export interface BadgeDefinitionOneEnvelopeData {
  badge: GamificationBadgeDefinitionDto;
}

export interface AdminSeasonsQuery {
  page?: number;
  limit?: number;
  kind?: string;
  search?: string;
}

export interface CreateSeasonBody {
  label?: string | null;
  kind: string;
  startsAt: string;
  endsAt: string;
  status?: string;
}

export interface PatchSeasonBody {
  label?: string | null;
  startsAt?: string;
  endsAt?: string;
  status?: string;
  kind?: string;
}

export interface SeasonsAdminListEnvelopeData {
  seasons: SeasonDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface SeasonCreatedEnvelopeData {
  season: SeasonDto;
}

export interface SeasonPatchEnvelopeData {
  season: SeasonDto;
}

export interface FinalizeSeasonQuery {
  openNext?: boolean;
}

export interface FinalizeSeasonBody {
  nextLabel?: string;
  startsAt?: string;
  endsAt?: string;
}

/** POST /admin/seasons/:id/finalize */
export interface SeasonFinalizeEnvelopeData {
  snapshotsWritten: number;
  closed?: SeasonDto;
  next?: SeasonDto;
}
