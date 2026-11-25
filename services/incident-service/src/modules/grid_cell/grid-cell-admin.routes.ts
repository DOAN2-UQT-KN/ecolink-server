import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware";
import { gridCellAdminController } from "./grid-cell-admin.controller";

const router = Router();

/**
 * @route   GET /api/v1/admin/grid-cells
 * @desc    100 m cells with their report counts and cleanup history summary.
 *          Query: sort (submitted|verified|last_report|last_cleaned|cleanup), min_reports,
 *          only_cleaned, page, limit.
 * @access  Private (admin)
 */
router.get("/", authenticate, gridCellAdminController.list);

/**
 * @route   POST /api/v1/admin/grid-cells/recompute
 * @desc    Rebuild every cell's counters from reports and cleanup rows (repair).
 * @access  Private (admin)
 */
router.post("/recompute", authenticate, gridCellAdminController.recompute);

/**
 * @route   GET /api/v1/admin/grid-cells/:cellKey
 * @desc    One cell with its reports (latest 200) and its cleanup history.
 * @access  Private (admin)
 */
router.get("/:cellKey", authenticate, gridCellAdminController.get);

export default router;
