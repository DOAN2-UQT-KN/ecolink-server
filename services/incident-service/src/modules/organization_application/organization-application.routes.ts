import { Router } from "express";
import {
  applicationPublicLimiter,
  otpPerEmailLimiter,
  otpPerIpLimiter,
} from "../../middleware/rate-limit.middleware";
import { optionalAuthenticate } from "../../middleware/auth.middleware";
import { organizationApplicationController } from "./organization-application.controller";

const router = Router();

/**
 * @route   POST /api/v1/organization-applications/email-otp
 * @desc    Mail a 6-digit code to the address an applicant claims to own. No login required.
 * @access  Public (rate limited: 3 / email / hour, 10 / IP / hour)
 * @body    { email }
 */
router.post(
  "/email-otp",
  otpPerIpLimiter,
  otpPerEmailLimiter,
  organizationApplicationController.requestOtp,
);

/**
 * @route   GET /api/v1/organization-applications/email-otp/link
 * @desc    Resolve the link mailed with the code to its address, so the form can reopen with
 *          the email locked. Grants nothing by itself; the code still has to be verified.
 * @access  Public
 * @query   token
 */
router.get(
  "/email-otp/link",
  applicationPublicLimiter,
  organizationApplicationController.resolveEmailLink,
);

/**
 * @route   POST /api/v1/organization-applications/email-otp/verify
 * @desc    Check the code, then open (or reopen) the mailbox's draft application and hand
 *          back its tracking token (180 days). From here on the tracking token is the
 *          credential for every applicant endpoint.
 * @access  Public
 * @body    { email, otp }
 * @returns { application_id, tracking_token, resumed }
 */
router.post(
  "/email-otp/verify",
  applicationPublicLimiter,
  organizationApplicationController.verifyOtp,
);

/**
 * @route   GET /api/v1/organization-applications/owner-confirmations/:token
 * @desc    What an owner candidate is being asked to agree to. A signed-in visitor whose email
 *          differs from the candidate's gets `session_email_mismatch: true`.
 * @access  Public with the token from the confirmation email
 */
router.get(
  "/owner-confirmations/:token",
  applicationPublicLimiter,
  optionalAuthenticate,
  organizationApplicationController.getOwnerConfirmation,
);

/**
 * @route   POST /api/v1/organization-applications/owner-confirmations/:token/confirm
 * @desc    Confirm being an owner. Idempotent. The last confirmation moves the application to
 *          PENDING_REVIEW. IP and user agent are recorded as evidence.
 * @access  Public with the token from the confirmation email
 */
router.post(
  "/owner-confirmations/:token/confirm",
  applicationPublicLimiter,
  organizationApplicationController.confirmOwner,
);

/**
 * @route   POST /api/v1/organization-applications/owner-confirmations/:token/decline
 * @desc    "I'm not involved". Sends the application back to the submitter (NEEDS_REVISION);
 *          `block_future` opts the email out of every future invitation.
 * @access  Public with the token from the confirmation email
 * @body    { reason?, block_future? }
 */
router.post(
  "/owner-confirmations/:token/decline",
  applicationPublicLimiter,
  organizationApplicationController.declineOwner,
);

/**
 * @route   POST /api/v1/organization-applications/:id/documents/presign
 * @desc    Upload slot for a legal document while the application is editable (DRAFT or
 *          NEEDS_REVISION). The next draft save attaches it.
 * @access  Public with the `token` from the tracking link
 * @query   token
 * @body    { doc_type, file_name, mime_type, size_bytes }
 */
router.post(
  "/:id/documents/presign",
  applicationPublicLimiter,
  organizationApplicationController.presignDocumentForApplication,
);

/**
 * @route   GET /api/v1/organization-applications/:id/documents/:docId/file
 * @desc    Stream one attached document back to the applicant (inline, for preview). Each
 *          open is logged as DOCUMENT_VIEWED without an actor.
 * @access  Public with the `token` from the tracking link
 * @query   token
 */
router.get(
  "/:id/documents/:docId/file",
  applicationPublicLimiter,
  organizationApplicationController.openDocument,
);

/**
 * @route   GET /api/v1/organization-applications/:id
 * @desc    Follow a submission: status, owner confirmations, and the saved draft fields.
 * @access  Public with the `token` from the tracking link
 * @query   token
 */
router.get(
  "/:id",
  applicationPublicLimiter,
  organizationApplicationController.getApplication,
);

/**
 * @route   PUT /api/v1/organization-applications/:id
 * @desc    Save the draft (DRAFT or NEEDS_REVISION). Every field is optional. `owners` is the
 *          full list; rows left out are marked removed.
 * @access  Public with the `token` from the tracking link
 * @query   token
 */
router.put(
  "/:id",
  applicationPublicLimiter,
  organizationApplicationController.saveDraft,
);

/**
 * @route   POST /api/v1/organization-applications/:id/submit
 * @desc    Validate everything and mail each owner a confirmation link. Goes straight to
 *          PENDING_REVIEW when the submitter is the only owner.
 * @access  Public with the `token` from the tracking link
 * @query   token
 * @body    { consent? }
 */
router.post(
  "/:id/submit",
  applicationPublicLimiter,
  organizationApplicationController.submitApplication,
);

/**
 * @route   POST /api/v1/organization-applications/:id/owners/:candidateId/resend
 * @desc    New confirmation link for one owner who has not answered (max 3, 1 hour apart).
 * @access  Public with the `token` from the tracking link
 * @query   token
 */
router.post(
  "/:id/owners/:candidateId/resend",
  applicationPublicLimiter,
  organizationApplicationController.resendOwnerInvite,
);

/**
 * @route   POST /api/v1/organization-applications/:id/withdraw
 * @desc    Withdraw an application that has not been decided yet (drafts included). Owners who
 *          already confirmed are told.
 * @access  Public with the `token` from the tracking link
 * @query   token
 */
router.post(
  "/:id/withdraw",
  applicationPublicLimiter,
  organizationApplicationController.withdrawApplication,
);

export default router;
