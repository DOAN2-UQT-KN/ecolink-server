import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware";
import { organizationController } from "./organization.controller";

const router = Router();

/**
 * @route   POST /api/v1/organizations
 * @desc    Create an organization; current user becomes the sole owner.
 * @access  Private
 */
router.post("/", authenticate, organizationController.createOrganization);

/**
 * @route   GET /api/v1/organizations/verify-contact-email
 * @desc    Confirm organization contact email (link from email); redirects to frontend.
 * @access  Public
 * @query   token — signed JWT from incident-service
 */
router.get(
  "/verify-contact-email",
  organizationController.verifyOrganizationContactEmail,
);

/**
 * @route   GET /api/v1/organizations/join-requests/my
 * @desc    Join requests I submitted (with organization summary).
 * @access  Private
 */
router.get(
  "/join-requests/my",
  authenticate,
  organizationController.getMyJoinRequests,
);

/**
 * @route   PUT /api/v1/organizations/join-requests/process
 * @desc    Approve or reject a join request (organization owner only).
 * @access  Private
 * @body    { requestId, approved }
 */
router.put(
  "/join-requests/process",
  authenticate,
  organizationController.processJoinRequest,
);

/**
 * @route   DELETE /api/v1/organizations/join-requests/cancel
 * @desc    Cancel my pending join request.
 * @access  Private
 * @body    { requestId }
 */
router.delete(
  "/join-requests/cancel",
  authenticate,
  organizationController.cancelJoinRequest,
);

/**
 * @route   GET /api/v1/organizations/my
 * @desc    Organizations I own or belong to as a member (search, status, is_email_verified, pagination). Each item may include request_status for my join request.
 * @access  Private
 * @query   search, status, is_email_verified, request_status (org join filter), page, limit, sortBy, sortOrder
 */
router.get(
  "/my",
  authenticate,
  organizationController.listMyOrganizations,
);

/**
 * @route   GET /api/v1/organizations
 * @desc    List organizations; filter by search, org status, is_email_verified, request_status (viewer’s latest join). Each item may include request_status when pending/approved.
 * @access  Private
 */
router.get("/", authenticate, organizationController.listOrganizations);

/**
 * @route   PUT /api/v1/organizations/:id/verify
 * @desc    Admin-approve an organization (status → active).
 * @access  Private (admin)
 */
router.put(
  "/:id/verify",
  authenticate,
  organizationController.adminVerifyOrganization,
);

/**
 * @route   PUT /api/v1/organizations/:id
 * @desc    Update organization (owner). Changing contact_email resets verification and sends a new link.
 * @access  Private (owner)
 */
router.put(
  "/:id",
  authenticate,
  organizationController.updateOrganization,
);

/**
 * @route   POST /api/v1/organizations/:id/resend-contact-email
 * @desc    Resend contact verification email (owner; only while contact email is not verified).
 * @access  Private (owner)
 */
router.post(
  "/:id/resend-contact-email",
  authenticate,
  organizationController.resendOrganizationContactEmail,
);

/**
 * @route   GET /api/v1/organizations/:id
 * @desc    Organization by id.
 * @access  Private
 */
router.get("/:id", authenticate, organizationController.getOrganizationById);
 
/**
 * @route   POST /api/v1/organizations/:id/join-requests
 * @desc    Request to join an organization.
 * @access  Private
 */
router.post(
  "/:id/join-requests",
  authenticate,
  organizationController.createJoinRequest,
);

/**
 * @route   GET /api/v1/organizations/:id/join-requests
 * @desc    List join requests for an organization (owner only).
 * @access  Private
 */
router.get(
  "/:id/join-requests",
  authenticate,
  organizationController.listJoinRequestsForOwner,
);

/**
 * @route   DELETE /api/v1/organizations/:id/members/me
 * @desc    Leave organization (active member only; owners cannot leave).
 * @access  Private
 */
router.delete(
  "/:id/members/me",
  authenticate,
  organizationController.leaveOrganization,
);

/**
 * @route   GET /api/v1/organizations/:id/members
 * @desc    List approved members (owner only; owner is not in this list).
 * @access  Private
 */
router.get(
  "/:id/members",
  authenticate,
  organizationController.listMembers,
);

export default router;
