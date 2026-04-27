import { Router } from "express";
import { reportController } from "./report.controller";
import { authenticate } from "../../middleware/auth.middleware";

const router = Router();

/**
 * @route   POST /api/v1/reports
 * @desc    Create a new report
 * @access  Private
 */
router.post("/", authenticate, reportController.createReport);

/**
 * @route   GET /api/v1/reports/search
 * @desc    Search and discover reports with filters and sorting
 * @access  Private
 */
router.get("/search", authenticate, reportController.searchReports);

/**
 * @route   GET /api/v1/reports/my
 * @desc    Current user's reports: same filters/sort as /search, plus page & limit (default page=1, limit=10). Response includes total, total_pages.
 * @access  Private
 */
router.get("/my", authenticate, reportController.getMyReports);

/**
 * @route   GET /api/v1/reports/by-ids
 * @desc    Report details by reportIds (max 100 UUIDs), same shape as GET /:id
 * @access  Private
 * @query   reportIds — comma-separated or repeated
 */
router.get("/by-ids", authenticate, reportController.getReportsByIds);

/**
 * @route   GET /api/v1/reports/media-files/by-ids
 * @desc    Report media file rows by ids (max 100); viewer must own the report or report must be verified.
 * @access  Private
 * @query   mediaFileIds — comma-separated or repeated UUIDs (report_media_files.id)
 */
router.get(
  "/media-files/by-ids",
  authenticate,
  reportController.getReportMediaFilesByIds,
);

/**
 * @route   GET /api/v1/reports/:id/background-jobs/status
 * @desc    Check if all background jobs for this report are done (no pending/in-process)
 * @access  Private
 */
router.get(
  "/:id/background-jobs/status",
  authenticate,
  reportController.getReportBackgroundJobsStatus,
);

/**
 * @route   GET /api/v1/reports/:id
 * @desc    Get report with full details
 * @access  Private
 */
router.get("/:id", authenticate, reportController.getReportDetail);

/**
 * @route   PUT /api/v1/reports/:id
 * @desc    Update a report
 * @access  Private (Report owner only; admins cannot edit)
 */
router.put("/:id", authenticate, reportController.updateReport);

/**
 * @route   POST /api/v1/reports/:id/media
 * @desc    Add images to a report
 * @access  Private (Report owner only; admins cannot edit)
 */
router.post("/:id/media", authenticate, reportController.addReportImages);

/**
 * @route   DELETE /api/v1/reports/:id/media/:mediaFileId
 * @desc    Soft-delete a report media file
 * @access  Private (Report owner only; admins cannot edit)
 */
router.delete(
  "/:id/media/:mediaFileId",
  authenticate,
  reportController.deleteReportMediaFile,
);

/**
 * @route   PUT /api/v1/reports/:id/verify
 * @desc    Admin-verify a report
 * @access  Private (Admin only)
 */
router.put("/:id/verify", authenticate, reportController.adminVerifyReport);

/**
 * @route   PUT /api/v1/reports/:id/ban
 * @desc    Ban a report (moderation)
 * @access  Private (Admin only)
 */
router.put("/:id/ban", authenticate, reportController.adminBanReport);



/**
 * @route   DELETE /api/v1/reports/:id
 * @desc    Delete a report (soft delete)
 * @access  Private (Report owner only; admins cannot delete — use ban)
 */
router.delete("/:id", authenticate, reportController.deleteReport);

// Managers and tasks live under /api/v1/campaigns — see campaign.routes.ts

export default router;

