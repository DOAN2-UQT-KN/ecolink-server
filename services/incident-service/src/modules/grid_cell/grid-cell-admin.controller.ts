import { Request, Response } from "express";
import { param, query, validationResult } from "express-validator";
import { HTTP_STATUS, sendError, sendHttpErrorResponse, sendSuccess } from "../../constants/http-status";
import { gridCellAdminService, type GridCellSort } from "./grid-cell-admin.service";

const SORTS: GridCellSort[] = ["submitted", "verified", "last_report", "last_cleaned", "cleanup"];

/** Same rule as the other admin controllers: this service has no role-guard middleware. */
function requireAdmin(req: Request, res: Response): boolean {
  if (!req.user?.userId) {
    sendError(res, HTTP_STATUS.UNAUTHORIZED);
    return false;
  }
  if (req.user.role?.toLowerCase() !== "admin") {
    sendError(res, HTTP_STATUS.FORBIDDEN.withMessage("Only admin can view grid cells"));
    return false;
  }
  return true;
}

function failedValidation(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
  return true;
}

export class GridCellAdminController {
  list = [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 500 }).toInt(),
    query("sort").optional().isIn(SORTS),
    query("min_reports").optional().isInt({ min: 0 }).toInt(),
    query("max_reports").optional().isInt({ min: 0 }).toInt(),
    query("only_cleaned").optional().isBoolean().toBoolean(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res) || !requireAdmin(req, res)) return;
      try {
        const result = await gridCellAdminService.list({
          sort: (req.query.sort as GridCellSort | undefined) ?? "submitted",
          minReports: Number(req.query.min_reports ?? 0),
          maxReports: req.query.max_reports === undefined ? undefined : Number(req.query.max_reports),
          onlyCleaned: String(req.query.only_cleaned) === "true",
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

  get = [
    param("cellKey").matches(/^\d+:-?\d+:-?\d+$/),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res) || !requireAdmin(req, res)) return;
      try {
        return sendSuccess(res, HTTP_STATUS.OK, await gridCellAdminService.getByKey(req.params.cellKey));
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  recompute = async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    try {
      return sendSuccess(res, HTTP_STATUS.OK, await gridCellAdminService.recompute());
    } catch (error) {
      if (sendHttpErrorResponse(res, error)) return;
      throw error;
    }
  };
}

export const gridCellAdminController = new GridCellAdminController();
