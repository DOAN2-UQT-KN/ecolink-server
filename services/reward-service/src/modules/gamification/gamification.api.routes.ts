import { Router, type Request as ExpressRequest } from "express";
import { authenticate } from "../../middleware/auth.middleware";
import { requireAdmin } from "../../middleware/require-admin.middleware";
import * as gc from "./gamification.controller";

const router = Router();

/** Controllers take the standard Express.Request. */
function er(req: unknown): ExpressRequest {
  return req as ExpressRequest;
}

// --- Admin: gamification config ---

/**
 * @route   GET /api/v1/admin/gamification/point-rules
 * @desc    Active point rules (earning rates and point expiry days)
 * @access  Private Admin
 */
router.get(
  "/admin/gamification/point-rules",
  authenticate,
  requireAdmin,
  (req, res) => gc.adminGetPointRules(er(req), res),
);

/**
 * @route   PATCH /api/v1/admin/gamification/point-rules
 * @desc    Replace the point rules (all rates and point expiry days); records a history row
 * @access  Private Admin
 */
router.patch(
  "/admin/gamification/point-rules",
  authenticate,
  requireAdmin,
  (req, res) => gc.adminPatchPointRules(er(req), res),
);

/**
 * @route   GET /api/v1/admin/gamification/point-rules/history
 * @desc    Point-rule saves, newest first (page, limit <= 100)
 * @access  Private Admin
 */
router.get(
  "/admin/gamification/point-rules/history",
  authenticate,
  requireAdmin,
  (req, res) => gc.adminGetPointRuleHistory(er(req), res),
);

export default router;
