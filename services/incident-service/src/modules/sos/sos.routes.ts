import { Router } from "express";
import { sosController } from "./sos.controller";
import { authenticate } from "../../middleware/auth.middleware";

const router = Router();

/**
 * @route   POST /api/v1/sos
 * @desc    Create an emergency SOS request under a campaign
 * @access  Private
 */
router.post("/", authenticate, sosController.createSos);

/**
 * @route   GET /api/v1/sos
 * @desc    List all SOS (filter by campaignId; distance query with lat/lng)
 * @access  Private
 */
router.get("/", authenticate, sosController.listSos);

/**
 * @route   PUT /api/v1/sos/:id/solved
 * @desc    Mark a SOS as solved (status → COMPLETED)
 * @access  Private
 */
router.put("/:id/solved", authenticate, sosController.solveSos);

export default router;
