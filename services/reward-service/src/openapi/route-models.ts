import type { OpenapiRouteModels } from "@da2/express-swagger";

export const OPENAPI_ROUTE_MODELS: OpenapiRouteModels = {
  "GET /api/v1/difficulties": {
    responseData: "DifficultiesListEnvelopeData",
  },
  "PUT /api/v1/difficulties/:id": {
    requestBody: "UpdateDifficultyBody",
    responseData: "DifficultyOneEnvelopeData",
  },
  "GET /api/v1/gifts": {
    query: "GiftListQuery",
    responseData: "GiftsListEnvelopeData",
  },
  "GET /api/v1/gifts/:id": {
    responseData: "GiftOneEnvelopeData",
  },
  "POST /api/v1/gifts": {
    requestBody: "CreateGiftBody",
    responseData: "GiftOneEnvelopeData",
  },
  "PUT /api/v1/gifts/:id": {
    requestBody: "UpdateGiftBody",
    responseData: "GiftOneEnvelopeData",
  },
  "POST /api/v1/gifts/:id/redeem": {
    responseData: "GiftRedemptionOneEnvelopeData",
  },
  "POST /api/v1/gifts/:id/exchange": {
    responseData: "GiftRedemptionOneEnvelopeData",
  },
  "GET /api/v1/me/points": {
    responseData: "MyPointsEnvelopeData",
  },
  "GET /api/v1/me/points/transactions": {
    query: "MyPointsTransactionsQuery",
    responseData: "MyPointsTransactionsEnvelopeData",
  },
  "GET /api/v1/leaderboard": {
    query: "LeaderboardQuery",
    responseData: "LeaderboardEnvelopeData",
  },
  "GET /api/v1/leaderboard/me": {
    responseData: "LeaderboardMeEnvelopeData",
  },
  "GET /api/v1/me/redemptions": {
    query: "MyGiftRedemptionsQuery",
    responseData: "MyGiftRedemptionsEnvelopeData",
  },

  "GET /api/v1/seasons/current": {
    responseData: "SeasonCurrentEnvelopeData",
  },
  "GET /api/v1/seasons/:id": {
    responseData: "SeasonOneEnvelopeData",
  },
  "GET /api/v1/me/gamification/summary": {
    responseData: "GamificationSummaryEnvelopeData",
  },
  "GET /api/v1/me/gamification/point-transactions": {
    query: "GamificationPointTransactionsQuery",
    responseData: "GamificationPointTransactionsEnvelopeData",
  },
  "GET /api/v1/me/gamification/points-by-season": {
    query: "PointsBySeasonQuery",
    responseData: "PointsBySeasonEnvelopeData",
  },
  "GET /api/v1/me/badges": {
    query: "MyBadgesQuery",
    responseData: "MyBadgesEnvelopeData",
  },
  "GET /api/v1/gamification/campaign-reward-estimate": {
    query: "CampaignRewardEstimateQuery",
    responseData: "CampaignRewardEstimateEnvelopeData",
  },
  "GET /api/v1/gamification/leaderboards/:metric": {
    query: "GamificationLeaderboardQuery",
    responseData: "GamificationLeaderboardEnvelopeData",
  },
  "GET /api/v1/gamification/leaderboards/:metric/me": {
    query: "GamificationLeaderboardQuery",
    responseData: "GamificationLeaderboardMeEnvelopeData",
  },

  "GET /api/v1/admin/gamification/point-rules": {
    responseData: "GamificationPointRulesOneEnvelopeData",
  },
  "PATCH /api/v1/admin/gamification/point-rules": {
    requestBody: "PatchGamificationPointRulesBody",
    responseData: "GamificationPointRulesOneEnvelopeData",
  },
  "GET /api/v1/admin/gamification/sp-rules": {
    responseData: "SpendablePointRulesOneEnvelopeData",
  },
  "PATCH /api/v1/admin/gamification/sp-rules": {
    requestBody: "PatchSpendablePointRulesBody",
    responseData: "SpendablePointRulesOneEnvelopeData",
  },
  "GET /api/v1/admin/gamification/multipliers": {
    responseData: "VolunteerMultipliersListEnvelopeData",
  },
  "PUT /api/v1/admin/gamification/multipliers": {
    requestBody: "PutVolunteerMultiplierBody",
    responseData: "VolunteerMultiplierOneEnvelopeData",
  },
  "GET /api/v1/admin/gamification/season-schedules": {
    responseData: "SeasonSchedulesListEnvelopeData",
  },
  "PUT /api/v1/admin/gamification/season-schedules": {
    requestBody: "PutSeasonScheduleBody",
    responseData: "SeasonScheduleOneEnvelopeData",
  },
  "GET /api/v1/admin/gamification/payout-tiers": {
    query: "AdminPayoutTiersQuery",
    responseData: "PayoutTiersListEnvelopeData",
  },
  "POST /api/v1/admin/gamification/payout-tiers": {
    requestBody: "CreateSeasonPayoutTierBody",
    responseData: "PayoutTierOneEnvelopeData",
  },
  "PATCH /api/v1/admin/gamification/payout-tiers/:id": {
    requestBody: "PatchSeasonPayoutTierBody",
    responseData: "PayoutTierOneEnvelopeData",
  },
  "DELETE /api/v1/admin/gamification/payout-tiers/:id": {
    responseData: "DeletePayoutTierEnvelopeData",
  },
  "GET /api/v1/admin/gamification/badges": {
    query: "AdminBadgeDefinitionsQuery",
    responseData: "BadgeDefinitionsListEnvelopeData",
  },
  "POST /api/v1/admin/gamification/badges": {
    requestBody: "CreateBadgeDefinitionBody",
    responseData: "BadgeDefinitionOneEnvelopeData",
  },
  "PATCH /api/v1/admin/gamification/badges/:id": {
    requestBody: "PatchBadgeDefinitionBody",
    responseData: "BadgeDefinitionOneEnvelopeData",
  },

  "GET /api/v1/admin/seasons": {
    query: "AdminSeasonsQuery",
    responseData: "SeasonsAdminListEnvelopeData",
  },
  "POST /api/v1/admin/seasons": {
    requestBody: "CreateSeasonBody",
    responseData: "SeasonCreatedEnvelopeData",
  },
  "PATCH /api/v1/admin/seasons/:id": {
    requestBody: "PatchSeasonBody",
    responseData: "SeasonPatchEnvelopeData",
  },
  "POST /api/v1/admin/seasons/:id/finalize": {
    query: "FinalizeSeasonQuery",
    requestBody: "FinalizeSeasonBody",
    responseData: "SeasonFinalizeEnvelopeData",
  },
};
