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
    requestBody: "RedeemGiftBody",
    responseData: "GiftRedemptionOneEnvelopeData",
  },
  "POST /api/v1/gifts/:id/exchange": {
    requestBody: "RedeemGiftBody",
    responseData: "GiftRedemptionOneEnvelopeData",
  },
  "GET /api/v1/admin/gift-redemptions": {
    query: "AdminGiftRedemptionsQuery",
    responseData: "AdminGiftRedemptionsEnvelopeData",
  },
  "PATCH /api/v1/admin/gift-redemptions/:id/status": {
    requestBody: "PatchGiftRedemptionStatusBody",
    responseData: "GiftRedemptionOneEnvelopeData",
  },
  "GET /api/v1/me/points": {
    responseData: "MyPointsEnvelopeData",
  },
  "GET /api/v1/me/points/transactions": {
    query: "MyPointsTransactionsQuery",
    responseData: "MyPointsTransactionsEnvelopeData",
  },
  "GET /api/v1/me/redemptions": {
    query: "MyGiftRedemptionsQuery",
    responseData: "MyGiftRedemptionsEnvelopeData",
  },

  "GET /api/v1/admin/gamification/point-rules": {
    responseData: "GamificationPointRulesOneEnvelopeData",
  },
  "PATCH /api/v1/admin/gamification/point-rules": {
    requestBody: "PatchGamificationPointRulesBody",
    responseData: "GamificationPointRulesOneEnvelopeData",
  },
  "GET /api/v1/admin/gamification/point-rules/history": {
    responseData: "GamificationPointRuleHistoryEnvelopeData",
  },
};
