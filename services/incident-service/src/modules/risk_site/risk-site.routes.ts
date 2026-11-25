import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware";
import { riskSiteController } from "./risk-site.controller";

const router = Router();

/**
 * @route   POST /api/v1/risk-sites/votes
 * @desc    Say whether a place flagged by the risk model really has trash.
 *          Body: lat, lng, address, verdict ("yes" | "no"). One answer per user and place; sending
 *          again changes it.
 * @access  Private
 */
router.post("/votes", authenticate, riskSiteController.vote);

export const adminRiskSiteRouter = Router();

/**
 * @route   GET /api/v1/admin/risk-sites
 * @desc    Per flagged place: how many people said "trash" and how many said "none". Query: page, limit.
 * @access  Private (admin)
 */
adminRiskSiteRouter.get("/", authenticate, riskSiteController.adminList);

export default router;
