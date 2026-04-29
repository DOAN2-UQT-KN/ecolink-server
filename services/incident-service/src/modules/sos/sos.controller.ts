import { Request, Response } from "express";
import { body, param, query, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { sosService } from "./sos.service";
import type { SosListQuery } from "./sos.dto";

export class SosController {
  constructor() {}

  /**
   * POST /api/v1/sos
   * Create an emergency SOS request under a campaign.
   */
  createSos = [
    body("campaignId")
      .isUUID()
      .withMessage("campaignId must be a valid UUID"),
    body("content")
      .notEmpty()
      .withMessage("content is required")
      .trim()
      .isLength({ max: 2000 })
      .withMessage("content must be at most 2000 characters"),
    body("phone")
      .notEmpty()
      .withMessage("phone is required")
      .trim()
      .matches(/^\+?\d{7,15}$/)
      .withMessage(
        "phone must be 7–15 digits, with an optional leading +",
      ),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const createdBy = req.user?.userId;
        const sos = await sosService.create(req.body, createdBy);
        sendSuccess(
          res,
          HTTP_STATUS.CREATED.withMessage("SOS created successfully"),
          { sos },
        );
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        console.error("Create SOS error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * GET /api/v1/sos
   * List all SOS, optionally filtered by campaignId.
   * Supports distance query when latitude & longitude are provided.
   */
  listSos = [
    query("campaignId").optional().isUUID().withMessage("campaignId must be a valid UUID"),
    query("status").optional().isInt().withMessage("status must be an integer"),
    query("latitude").optional().isFloat({ min: -90, max: 90 }).withMessage("latitude must be between -90 and 90"),
    query("longitude").optional().isFloat({ min: -180, max: 180 }).withMessage("longitude must be between -180 and 180"),
    query("maxDistance").optional().isInt({ min: 1 }).withMessage("maxDistance must be a positive integer (metres)"),
    query("page").optional().isInt({ min: 1 }).withMessage("page must be a positive integer"),
    query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("limit must be between 1 and 100"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const listQuery: SosListQuery = {
          campaignId: req.query.campaignId as string | undefined,
          status: req.query.status
            ? parseInt(req.query.status as string, 10)
            : undefined,
          latitude: req.query.latitude
            ? parseFloat(req.query.latitude as string)
            : undefined,
          longitude: req.query.longitude
            ? parseFloat(req.query.longitude as string)
            : undefined,
          maxDistance: req.query.maxDistance
            ? parseInt(req.query.maxDistance as string, 10)
            : undefined,
          page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
          limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
        };

        const result = await sosService.list(listQuery);
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        console.error("List SOS error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * PUT /api/v1/sos/:id/solved
   * Mark a SOS as solved (status → COMPLETED).
   */
  solveSos = [
    param("id").isInt({ min: 1 }).withMessage("id must be a positive integer"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const updatedBy = req.user?.userId;
        const sos = await sosService.solveSos(
          parseInt(req.params.id, 10),
          updatedBy,
        );
        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("SOS marked as solved"),
          { sos },
        );
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        console.error("Solve SOS error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];
}

export const sosController = new SosController();
