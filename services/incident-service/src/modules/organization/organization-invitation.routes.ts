import { Router } from "express";
import { optionalAuthenticate } from "../../middleware/auth.middleware";
import { applicationPublicLimiter } from "../../middleware/rate-limit.middleware";
import { organizationInvitationController } from "./organization-invitation.controller";

/**
 * Public side of member invitations, mounted at /api/v1/organization-invitations. The token
 * mailed to the invitee is the only credential.
 */
const router = Router();

/**
 * @route   GET /api/v1/organization-invitations/:token
 * @desc    What the invitee is being asked to join. A signed-in visitor who is not the
 *          invitee gets `session_mismatch: true`.
 * @access  Public with the token from the invitation email
 */
router.get(
  "/:token",
  applicationPublicLimiter,
  optionalAuthenticate,
  organizationInvitationController.getByToken,
);

/**
 * @route   POST /api/v1/organization-invitations/:token/accept
 * @desc    Join the organization as MEMBER. Idempotent.
 * @access  Public with the token from the invitation email
 */
router.post(
  "/:token/accept",
  applicationPublicLimiter,
  organizationInvitationController.accept,
);

/**
 * @route   POST /api/v1/organization-invitations/:token/decline
 * @access  Public with the token from the invitation email
 */
router.post(
  "/:token/decline",
  applicationPublicLimiter,
  organizationInvitationController.decline,
);

export default router;
