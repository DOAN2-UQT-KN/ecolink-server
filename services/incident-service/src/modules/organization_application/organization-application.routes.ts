import { Router } from "express";
import {
  applicationPublicLimiter,
  otpPerEmailLimiter,
  otpPerIpLimiter,
} from "../../middleware/rate-limit.middleware";
import { organizationApplicationController } from "./organization-application.controller";
import { requireSubmissionToken } from "./submission-token.middleware";

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
 * @route   POST /api/v1/organization-applications/email-otp/verify
 * @desc    Exchange the code for a single-use submission token (valid 30 minutes).
 * @access  Public
 * @body    { email, otp }
 */
router.post(
  "/email-otp/verify",
  applicationPublicLimiter,
  organizationApplicationController.verifyOtp,
);

/**
 * @route   POST /api/v1/organization-applications/documents/presign
 * @desc    Signed parameters for uploading one legal document to private storage.
 * @access  Public with `x-submission-token`
 * @body    { doc_type, file_name, mime_type, size_bytes }
 */
router.post(
  "/documents/presign",
  applicationPublicLimiter,
  requireSubmissionToken,
  organizationApplicationController.presignDocument,
);

/**
 * @route   POST /api/v1/organization-applications
 * @desc    Submit an application. Burns the submission token and mails a tracking link.
 * @access  Public with `x-submission-token`
 * @body    { org_type, profile, channels, legal_representative?, document_ids?, consent }
 */
router.post(
  "/",
  applicationPublicLimiter,
  requireSubmissionToken,
  organizationApplicationController.createApplication,
);

/**
 * @route   GET /api/v1/organization-applications/:id
 * @desc    Follow a submission. Review-only fields (legal representative) are never included.
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
 * @desc    Resubmit after a reviewer requested more information (NEEDS_MORE_INFO only).
 * @access  Public with the `token` from the tracking link
 * @query   token
 */
router.put(
  "/:id",
  applicationPublicLimiter,
  organizationApplicationController.updateApplication,
);

/**
 * @route   POST /api/v1/organization-applications/:id/withdraw
 * @desc    Withdraw a submission that has not been decided yet.
 * @access  Public with the `token` from the tracking link
 * @query   token
 */
router.post(
  "/:id/withdraw",
  applicationPublicLimiter,
  organizationApplicationController.withdrawApplication,
);

export default router;
