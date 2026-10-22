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
  "GET /api/v1/admin/gift-redemptions": {
    query: "AdminGiftRedemptionsQuery",
    responseData: "AdminGiftRedemptionsEnvelopeData",
  },
  "PATCH /api/v1/admin/gift-redemptions/:id/status": {
    requestBody: "PatchGiftRedemptionStatusBody",
    responseData: "GiftRedemptionOneEnvelopeData",
  },
  "PATCH /api/v1/admin/gift-redemptions/:id/tracking": {
    requestBody: "UpdateTrackingBody",
    responseData: "GiftRedemptionOneEnvelopeData",
  },
  "GET /api/v1/admin/gift-redemptions/:code": {
    responseData: "AdminGiftRedemptionDetailEnvelopeData",
  },
  "GET /api/v1/admin/gift-sources": {
    query: "GiftSourceListQuery",
    responseData: "GiftSourcesListEnvelopeData",
  },
  "POST /api/v1/admin/gift-sources": {
    requestBody: "CreateGiftSourceBody",
    responseData: "GiftSourceOneEnvelopeData",
  },
  "GET /api/v1/admin/gift-sources/:id": {
    responseData: "GiftSourceOneEnvelopeData",
  },
  "PUT /api/v1/admin/gift-sources/:id": {
    requestBody: "UpdateGiftSourceBody",
    responseData: "GiftSourceOneEnvelopeData",
  },
  "GET /api/v1/admin/gift-sources/:id/batches": {
    query: "StockBatchListQuery",
    responseData: "StockBatchesListEnvelopeData",
  },
  "GET /api/v1/admin/gift-sources/:id/report": {
    query: "GiftSourceReportQuery",
    responseData: "GiftSourceReportEnvelopeData",
  },
  "GET /api/v1/admin/gifts/:id/stock-batches": {
    query: "StockBatchListQuery",
    responseData: "StockBatchesListEnvelopeData",
  },
  "POST /api/v1/admin/gifts/:id/stock-batches": {
    requestBody: "CreateStockBatchBody",
    responseData: "StockBatchCreatedEnvelopeData",
  },
  "POST /api/v1/admin/stock-batches/:id/adjustments": {
    requestBody: "AdjustStockBatchBody",
    responseData: "StockAdjustedEnvelopeData",
  },
  "GET /api/v1/admin/gifts/:id/stock-movements": {
    query: "StockMovementListQuery",
    responseData: "StockMovementsListEnvelopeData",
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
  "GET /api/v1/me/redemptions/:code": {
    responseData: "MyGiftRedemptionDetailEnvelopeData",
  },
  "POST /api/v1/me/redemptions/:code/cancel": {
    requestBody: "CancelMyRedemptionBody",
    responseData: "MyGiftRedemptionDetailEnvelopeData",
  },
  "POST /api/v1/me/redemptions/:code/confirm-delivery": {
    responseData: "MyGiftRedemptionDetailEnvelopeData",
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
