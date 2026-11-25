import { Request, Response } from "express";
import { body, query, validationResult } from "express-validator";
import { HTTP_STATUS, sendError, sendHttpErrorResponse, sendSuccess } from "../../constants/http-status";
import { riskSiteService } from "./risk-site.service";

function failedValidation(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
  return true;
}

export class RiskSiteController {
  /** Any signed-in user can answer; admins read the totals. */
  vote = [
    body("lat").isFloat({ min: -90, max: 90 }).toFloat(),
    body("lng").isFloat({ min: -180, max: 180 }).toFloat(),
    body("address").isString().trim().isLength({ min: 1, max: 255 }),
    body("verdict").isIn(["yes", "no"]),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      if (!req.user?.userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      try {
        const result = await riskSiteService.vote({
          userId: req.user.userId,
          lat: Number(req.body.lat),
          lng: Number(req.body.lng),
          address: String(req.body.address),
          verdict: req.body.verdict,
        });
        return sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  adminList = [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      if (!req.user?.userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      if (req.user.role?.toLowerCase() !== "admin") {
        return sendError(res, HTTP_STATUS.FORBIDDEN.withMessage("Only admin can view risk site votes"));
      }
      try {
        const result = await riskSiteService.listForAdmin({
          page: Number(req.query.page ?? 1),
          limit: Number(req.query.limit ?? 20),
        });
        return sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];
}

export const riskSiteController = new RiskSiteController();
