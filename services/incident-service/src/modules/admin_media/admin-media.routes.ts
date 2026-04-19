import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware";
import { adminMediaController } from "./admin-media.controller";

const router = Router();

/**
 * @route   POST /api/v1/admin/media
 * @desc    Register a public image URL as Media (admin; for catalog assets such as gifts)
 * @access  Private (Admin)
 */
router.post("/", authenticate, adminMediaController.registerFromImageUrl);

export default router;
