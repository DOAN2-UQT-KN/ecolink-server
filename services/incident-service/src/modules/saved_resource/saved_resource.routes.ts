import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware";
import { savedResourceController } from "./saved_resource.controller";

const router = Router();

/**
 * @route   POST /api/v1/saved-resources/save
 * @desc    Save or unsave a resource (toggle when already saved).
 * @access  Private
 */
router.post("/save", authenticate, savedResourceController.save);

export default router;
