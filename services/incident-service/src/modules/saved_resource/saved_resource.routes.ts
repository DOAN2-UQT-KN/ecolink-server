import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware";
import { savedResourceController } from "./saved_resource.controller";

const router = Router();

/**
 * @route   GET /incident/saved-resources
 * @desc    Paginated list of resources the current user saved (optional filter by resourceType).
 * @access  Private
 * @query   page?, limit?, resourceType? (report|campaign), sortBy? (createdAt|updatedAt), sortOrder? (asc|desc)
 */
router.get("/", authenticate, savedResourceController.list);

/**
 * @route   POST /incident/saved-resources/save
 * @desc    Save or unsave a resource (toggle when already saved).
 * @access  Private
 */
router.post("/save", authenticate, savedResourceController.save);

export default router;
