import { Router, type Request as ExpressRequest } from "express";
import { query, validationResult } from "express-validator";
import { HTTP_STATUS, sendError } from "../../constants/http-status";
import { authenticate } from "../../middleware/auth.middleware";
import * as mc from "./metrics.controller";

const router = Router();

function er(req: unknown): ExpressRequest {
  return req as ExpressRequest;
}

/**
 * @route   GET /api/v1/metric-tables
 * @desc    Active logical metric tables for badge rule builder (filter by label)
 * @access  Private
 */
router.get(
  "/metric-tables",
  authenticate,
  query("label").optional().isString().trim(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void mc.getMetricTables(er(req), res);
  },
);

/**
 * @route   GET /api/v1/metric-columns
 * @desc    Active metric columns (optional filter by label and metricTableId)
 * @access  Private
 */
router.get(
  "/metric-columns",
  authenticate,
  query("label").optional().isString().trim(),
  query("metricTableId").optional().isUUID(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void mc.getMetricColumns(er(req), res);
  },
);

export default router;
