import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware";
import { requireInternalIncidentApiKey } from "../../middleware/internal-auth.middleware";
import { organizationController } from "./organization.controller";
import { organizationInvitationController } from "./organization-invitation.controller";
import { ownerProposalController } from "../organization_application/owner-proposal.controller";

const router = Router();

/**
 * @route   POST /api/v1/organizations
 * @desc    Create an organization directly, bypassing the application pipeline.
 *          No longer reachable by end users: organizations may only come into existence
 *          through an approved application, so this is kept for internal tooling and
 *          fixtures and requires `x-internal-api-key`.
 * @access  Internal (`x-internal-api-key`)
 * @body    { owner_id, name, logo_url, contact_email, ... }
 */
router.post(
  "/",
  requireInternalIncidentApiKey,
  organizationController.createOrganization,
);

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
 * @desc    Organizations I own or belong to as a member (search, status, is_email_verified, is_owner, pagination). Each item includes members (active member count) and may include request_status / join_request_id for my join request.
 * @access  Private
 * @query   search, status (repeat or comma list), is_email_verified, is_owner (or isOwner: true|false|1|0), request_status (repeat or comma), page, limit, sortBy, sortOrder
 */
router.get(
  "/my",
  authenticate,
  organizationController.listMyOrganizations,
);

/**
 * @route   GET /api/v1/organizations
 * @desc    List organizations; filter by search, org status (repeat/comma), is_email_verified, request_status (repeat/comma). Each item includes members (active member count) and may include request_status / join_request_id when pending/approved.
 * @access  Private
 */
router.get("/", authenticate, organizationController.listOrganizations);

/**
 * @route   GET /api/v1/organizations/by-slug/:slug
 * @desc    Organization by public slug (includes `owner` profile from identity-service; may include request_status / join_request_id for the viewer).
 * @access  Private
 */
router.get(
  "/by-slug/:slug",
  authenticate,
  organizationController.getOrganizationBySlug,
);

/**
 * @route   PUT /api/v1/organizations/:id/verify
 * @desc    Admin verify or ban an organization (`GlobalStatus` in body: active or inactive).
 * @access  Private (admin)
 * @body    { status, reject_reason? } — `1` (`_STATUS_ACTIVE`) to verify, `2` (`_STATUS_INACTIVE`) to ban. `reject_reason` is required when banning.
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
 * @desc    Organization by id (includes `owner` profile from identity-service: id, name, avatar, bio).
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
 * @desc    List join requests for an organization (owner only). Each item includes `requester` profile (identity-service).
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
 * @route   PATCH /api/v1/organizations/:id/members/:userId/role
 * @desc    Change a non-owner member's role. Needs MEMBER_MANAGE; the new role must be in the
 *          caller's `assignableRoles` (owner: ADMIN/CAMPAIGN_MANAGER/MEMBER, admin:
 *          CAMPAIGN_MANAGER/MEMBER); an admin cannot act on another admin; owners are untouchable.
 * @access  Private
 * @body    { role }
 */
router.patch(
  "/:id/members/:userId/role",
  authenticate,
  organizationController.changeMemberRole,
);

/**
 * @route   DELETE /api/v1/organizations/:id/members/:userId
 * @desc    Remove a non-owner member (same bounds as changing their role).
 * @access  Private
 */
router.delete(
  "/:id/members/:userId",
  authenticate,
  organizationController.removeMember,
);

/**
 * @route   GET /api/v1/organizations/:id/members
 * @desc    List members with their role (owners included). Each item includes `user` profile (identity-service). Pagination: page, limit. Filter: userId, search (member display name, case-insensitive contains, via identity-service).
 * @access  Private
 */
router.get(
  "/:id/members",
  authenticate,
  organizationController.listMembers,
);

/**
 * @route   GET /api/v1/organizations/:id/user-search?q=
 * @desc    Find people to invite (or to propose as owners). Needs MEMBER_INVITE. Emails are
 *          masked unless the caller may propose owners. Each result says whether the person
 *          already has a role here.
 * @access  Private
 */
router.get(
  "/:id/user-search",
  authenticate,
  organizationInvitationController.searchUsers,
);

/**
 * @route   POST /api/v1/organizations/:id/invitations
 * @desc    Invite an existing user as MEMBER. Anyone in the organization may invite; the
 *          invitation is SENT at once if the inviter can approve members, otherwise it waits
 *          as PENDING_APPROVAL.
 * @access  Private
 * @body    { user_id }
 */
router.post(
  "/:id/invitations",
  authenticate,
  organizationInvitationController.create,
);

/**
 * @route   GET /api/v1/organizations/:id/invitations?status=
 * @desc    Approvers see every invitation; other members only the ones they sent.
 * @access  Private
 */
router.get(
  "/:id/invitations",
  authenticate,
  organizationInvitationController.list,
);

/**
 * @route   PUT /api/v1/organizations/:id/invitations/:invitationId/approve
 * @desc    Approve a pending invitation (MEMBER_APPROVE); the invitee is emailed a link.
 * @access  Private
 */
router.put(
  "/:id/invitations/:invitationId/approve",
  authenticate,
  organizationInvitationController.approve,
);

/**
 * @route   PUT /api/v1/organizations/:id/invitations/:invitationId/reject
 * @access  Private (MEMBER_APPROVE)
 */
router.put(
  "/:id/invitations/:invitationId/reject",
  authenticate,
  organizationInvitationController.reject,
);

/**
 * @route   DELETE /api/v1/organizations/:id/invitations/:invitationId
 * @desc    Cancel an open invitation (the inviter, or anyone with MEMBER_APPROVE).
 * @access  Private
 */
router.delete(
  "/:id/invitations/:invitationId",
  authenticate,
  organizationInvitationController.cancel,
);

/**
 * @route   POST /api/v1/organizations/:id/owner-proposals
 * @desc    Propose new owners (ADD_OWNER application). Needs OWNER_PROPOSE. Each person is
 *          an existing account (`user_id`) or an email; every one confirms by email, then a
 *          platform admin reviews. One open proposal per organization.
 * @access  Private
 * @body    { owners: [{ user_id? , email?, full_name }], reason? }
 */
router.post(
  "/:id/owner-proposals",
  authenticate,
  ownerProposalController.create,
);

/**
 * @route   GET /api/v1/organizations/:id/owner-proposals
 * @desc    Recent ADD_OWNER proposals with each person's confirmation status (owners only).
 * @access  Private
 */
router.get(
  "/:id/owner-proposals",
  authenticate,
  ownerProposalController.list,
);

/**
 * @route   POST /api/v1/organizations/:id/owner-proposals/:applicationId/cancel
 * @access  Private (OWNER_PROPOSE)
 */
router.post(
  "/:id/owner-proposals/:applicationId/cancel",
  authenticate,
  ownerProposalController.cancel,
);

/**
 * @route   POST /api/v1/organizations/:id/owner-proposals/:applicationId/owners/:candidateId/resend
 * @desc    New confirmation link for one pending person (at least an hour apart).
 * @access  Private (OWNER_PROPOSE)
 */
router.post(
  "/:id/owner-proposals/:applicationId/owners/:candidateId/resend",
  authenticate,
  ownerProposalController.resend,
);

export default router;
