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
  "GET /api/v1/gifts/me/green-points": {
    responseData: "MyGreenPointsEnvelopeData",
  },
  "GET /api/v1/gifts/me/redemptions": {
    query: "MyGiftRedemptionsQuery",
    responseData: "MyGiftRedemptionsEnvelopeData",
  },
};
