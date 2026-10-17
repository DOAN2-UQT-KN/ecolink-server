import { Router } from "express";
import { reportController } from "./report.controller";
import { authenticate } from "../../middleware/auth.middleware";
import { verificationController } from "../verification/verification.controller";

const router = Router();

/**
 * @route   POST /api/v1/reports
 * @desc    Create a new report
 * @access  Private
 */
router.post("/", authenticate, reportController.createReport);

/**
 * @route   POST /api/v1/reports/captures
 * @desc    Start a camera capture (specs/006 P03): returns capture_id, expires_at and a Cloudinary
 *          upload signature for public_id `captures/<capture_id>`. Send the capture_id with the image
 *          in POST /reports so it counts as LIVE.
 * @access  Private
 */
router.post("/captures", authenticate, reportController.createCapture);

/**
 * @route   GET /api/v1/reports/context
 * @desc    Categories that fit the pinned point (query lat, lng), with the nearest place found via Goong
 *          (specs/006 P08). A hint only: 503 CONTEXT_UNAVAILABLE when off, slow (> 2 s) or failing; the
 *          client then shows the full category list.
 * @access  Private
 */
router.get("/context", authenticate, reportController.getLocationContext);

/**
 * @route   GET /api/v1/reports/search
 * @desc    Search and discover reports with filters and sorting. Optional `statuses` (comma-separated or repeated ints) filters `status IN statuses`. Each report includes duplicate_verification.
 * @access  Private
 */
router.get("/search", authenticate, reportController.searchReports);

/**
 * @route   GET /api/v1/reports/my
 * @desc    Current user's reports: same filters/sort as /search, plus page & limit (default page=1, limit=10). Response includes total, total_pages, and duplicate_verification per report.
 * @access  Private
 */
router.get("/my", authenticate, reportController.getMyReports);

/**
 * @route   GET /api/v1/reports/all
 * @desc    All reports with status ACTIVE only (no pagination)
 * @access  Private
 */
router.get("/all", authenticate, reportController.getAllActiveReports);

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
 * @route   GET /api/v1/reports/moderation
 * @desc    Moderator queue (specs/006 P09). Query `flag` REVIEW (status 9, default) or REJECT (rejected by the engine, no moderator decision yet), `page`, `limit` (1..100, default 20). Highest risk first; `counts` per tab.
 * @access  Private (Admin only)
 */
router.get("/moderation", authenticate, verificationController.moderationQueue);

/**
 * @route   GET /api/v1/reports/:id/verification
 * @desc    Latest verification attempt. Owner: status, flag and public issues only; admin: score, checks, signals, evidence, moderation.
 * @access  Private (Report owner or admin)
 */
router.get("/:id/verification", authenticate, verificationController.getVerification);

/**
 * @route   GET /api/v1/reports/:id/verifications
 * @desc    Every verification attempt of the report, newest first (admin view).
 * @access  Private (Admin only)
 */
router.get("/:id/verifications", authenticate, verificationController.listVerifications);

/**
 * @route   POST /api/v1/reports/:id/moderation
 * @desc    Moderator decision `{ decision: ACCEPT | REJECT, reason_code (required for REJECT), note? }` on a report in review or rejected by the engine. 409 REPORT_ALREADY_MODERATED otherwise.
 * @access  Private (Admin only)
 */
router.post("/:id/moderation", authenticate, verificationController.moderate);

/**
 * @route   GET /api/v1/reports/:id
 * @desc    Get report with full details including duplicate_verification (null until AI writes back). Banned (inactive) reports return 404.
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
 * @desc    Ban a report (moderation). Body `{ reject_reason }` is required.
 * @access  Private (Admin only)
 */
router.put("/:id/ban", authenticate, reportController.adminBanReport);

/**
 * @route   PUT /api/v1/reports/:id/mark-done
 * @desc    Mark report as done/completed (admin only)
 * @access  Private (Admin only)
 */
router.put(
  "/:id/mark-done",
  authenticate,
  reportController.adminMarkReportDone,
);



/**
 * @route   DELETE /api/v1/reports/:id
 * @desc    Delete a report (soft delete)
 * @access  Private (Report owner only; admins cannot delete — use ban)
 */
router.delete("/:id", authenticate, reportController.deleteReport);

// Campaign managers live under /api/v1/campaigns — see campaign.routes.ts

export default router;

