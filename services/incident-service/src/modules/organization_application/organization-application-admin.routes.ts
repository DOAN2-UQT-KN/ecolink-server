import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware";
import { organizationApplicationAdminController } from "./organization-application-admin.controller";

const router = Router();

/**
 * @route   GET /api/v1/admin/organization-applications
 * @desc    Review queue. Filter by status, org_type, lane (repeat or comma) and free text `q`
 *          (application code, contact email, representative name). Pagination: page, limit.
 * @access  Private (admin)
 */
router.get(
  "/",
  authenticate,
  organizationApplicationAdminController.listApplications,
);

/**
 * @route   GET /api/v1/admin/organization-applications/:id
 * @desc    Full submission including review-only fields and the audit trail.
 * @access  Private (admin)
 */
router.get(
  "/:id",
  authenticate,
  organizationApplicationAdminController.getApplication,
);

/**
 * @route   GET /api/v1/admin/organization-applications/:id/documents/:docId/file
 * @desc    Stream one legal document. The file is proxied, never handed out as a URL, and
 *          each view is written to `organization_application_events`.
 * @access  Private (admin)
 */
router.get(
  "/:id/documents/:docId/file",
  authenticate,
  organizationApplicationAdminController.openDocument,
);

/**
 * @route   PUT /api/v1/admin/organization-applications/:id/claim
 * @desc    Take the application (status -> UNDER_REVIEW) so two admins do not collide.
 * @access  Private (admin)
 */
router.put(
  "/:id/claim",
  authenticate,
  organizationApplicationAdminController.claimApplication,
);

/**
 * @route   PUT /api/v1/admin/organization-applications/:id/request-info
 * @desc    Ask the applicant for missing paperwork (status -> NEEDS_MORE_INFO).
 * @access  Private (admin)
 * @body    { message }
 */
router.put(
  "/:id/request-info",
  authenticate,
  organizationApplicationAdminController.requestMoreInfo,
);

/**
 * @route   PUT /api/v1/admin/organization-applications/:id/decision
 * @desc    Approve (creates the organization and schedules its ORG account) or reject.
 * @access  Private (admin)
 * @body    { decision: "APPROVE"|"REJECT", lane?: "A"|"B", documents_waived?,
 *            documents_waived_reason?, reject_reason?, grant_blue_tick? }
 */
router.put(
  "/:id/decision",
  authenticate,
  organizationApplicationAdminController.decideApplication,
);

export default router;
