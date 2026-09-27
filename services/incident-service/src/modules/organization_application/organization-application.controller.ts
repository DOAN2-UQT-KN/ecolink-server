import { Request, Response } from "express";
import { body, param, query, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { clientIp } from "../../middleware/rate-limit.middleware";
import {
  ConfirmationRequestMeta,
  PresignApplicationDocumentBody,
  RequestApplicationOtpBody,
  SaveApplicationBody,
  SubmitApplicationBody,
  VerifyApplicationOtpBody,
} from "./organization-application.dto";
import { organizationApplicationOtpService } from "./organization-application-otp.service";
import { organizationApplicationService } from "./organization-application.service";
import { ownerConfirmationService } from "./owner-confirmation.service";
import { sendDocumentStream } from "./document-stream";

export function requestMeta(req: Request): ConfirmationRequestMeta {
  const ua = req.get("user-agent");
  return {
    ip: clientIp(req)?.slice(0, 64) ?? null,
    userAgent: ua ? ua.slice(0, 512) : null,
  };
}

/** The tracking-link token, from `?token=` (preferred) or the body. */
function trackingTokenOf(req: Request): string {
  return String(req.query.token ?? req.body?.token ?? "").trim();
}

function failedValidation(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
  return true;
}

export class OrganizationApplicationController {
  /* ------------------------------------------------------------------ */
  /* P0 — prove the mailbox                                              */
  /* ------------------------------------------------------------------ */

  requestOtp = [
    body("email").notEmpty().trim().isEmail().isLength({ max: 320 }),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      try {
        const { email } = req.body as RequestApplicationOtpBody;
        const { sentAt, expiresAt } =
          await organizationApplicationOtpService.requestOtp(email);
        return sendSuccess(res, HTTP_STATUS.OK, {
          sent: true,
          sentAt: sentAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  resolveEmailLink = [
    query("token").notEmpty().trim().isLength({ max: 128 }),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      try {
        const result = await organizationApplicationOtpService.resolveEmailLink(
          String(req.query.token),
        );
        return sendSuccess(res, HTTP_STATUS.OK, {
          email: result.email,
          sentAt: result.sentAt.toISOString(),
          expiresAt: result.expiresAt.toISOString(),
        });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  verifyOtp = [
    body("email").notEmpty().trim().isEmail().isLength({ max: 320 }),
    body("otp")
      .notEmpty()
      .trim()
      .isLength({ min: 4, max: 10 })
      .withMessage("otp is required"),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      try {
        const { email, otp } = req.body as VerifyApplicationOtpBody;
        const verified = await organizationApplicationOtpService.verifyOtp(
          email,
          otp,
        );
        const result =
          await organizationApplicationService.openDraftForEmail(verified);
        return sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  /* ------------------------------------------------------------------ */
  /* P1 — documents                                                      */
  /* ------------------------------------------------------------------ */

  presignDocumentForApplication = [
    param("id").isUUID(),
    query("token").notEmpty().trim(),
    body("docType").notEmpty().trim().isLength({ max: 32 }),
    body("fileName").notEmpty().trim().isLength({ max: 255 }),
    body("mimeType").notEmpty().trim().isLength({ max: 100 }),
    body("sizeBytes").isInt({ min: 1 }).toInt(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      try {
        const result =
          await organizationApplicationService.presignDocumentForApplication(
            req.params.id,
            String(req.query.token),
            req.body as PresignApplicationDocumentBody,
          );
        return sendSuccess(res, HTTP_STATUS.CREATED, result);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  /* ------------------------------------------------------------------ */
  /* P2 — submit / track / edit / withdraw                               */
  /* ------------------------------------------------------------------ */

  getApplication = [
    param("id").isUUID(),
    query("token").notEmpty().trim(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      try {
        const application =
          await organizationApplicationService.getForApplicant(
            req.params.id,
            String(req.query.token),
          );
        return sendSuccess(res, HTTP_STATUS.OK, { application });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  saveDraft = [
    param("id").isUUID(),
    body("orgType").optional({ values: "null" }).trim().isLength({ max: 32 }),
    body("profile").optional().isObject(),
    body("channels").optional().isArray({ max: 10 }),
    body("legalRepresentative").optional().isObject(),
    body("owners").optional().isArray({ max: 5 }),
    body("owners.*.email").optional().isString().isLength({ max: 320 }),
    body("owners.*.fullName").optional().isString().isLength({ max: 200 }),
    body("owners.*.isLegalRep").optional().isBoolean().toBoolean(),
    body("owners.*.nationalIdDocumentId").optional({ values: "null" }).isUUID(),
    body("documentIds").optional().isArray({ max: 5 }),
    body("documentIds.*").optional().isUUID(),
    body("removeDocumentIds").optional().isArray({ max: 5 }),
    body("removeDocumentIds.*").optional().isUUID(),
    body("consent").optional().isBoolean().toBoolean(),
    body("notifySubmitter").optional().isBoolean().toBoolean(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      const token = trackingTokenOf(req);
      if (!token) {
        return sendError(res, HTTP_STATUS.TRACKING_TOKEN_INVALID);
      }
      try {
        const { application, notified } =
          await organizationApplicationService.saveDraft(
            req.params.id,
            token,
            req.body as SaveApplicationBody,
          );
        return sendSuccess(res, HTTP_STATUS.OK, { application, notified });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  submitApplication = [
    param("id").isUUID(),
    body("consent").optional().isBoolean().toBoolean(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      const token = trackingTokenOf(req);
      if (!token) {
        return sendError(res, HTTP_STATUS.TRACKING_TOKEN_INVALID);
      }
      try {
        const application =
          await organizationApplicationService.submitApplication(
            req.params.id,
            token,
            req.body as SubmitApplicationBody,
            requestMeta(req),
          );
        return sendSuccess(res, HTTP_STATUS.OK, { application });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  resendOwnerInvite = [
    param("id").isUUID(),
    param("candidateId").isUUID(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      const token = trackingTokenOf(req);
      if (!token) {
        return sendError(res, HTTP_STATUS.TRACKING_TOKEN_INVALID);
      }
      try {
        const application =
          await organizationApplicationService.resendOwnerInvite(
            req.params.id,
            token,
            req.params.candidateId,
          );
        return sendSuccess(res, HTTP_STATUS.OK, { application });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  openDocument = [
    param("id").isUUID(),
    param("docId").isUUID(),
    query("token").notEmpty().trim(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      try {
        const file =
          await organizationApplicationService.openDocumentForApplicant(
            req.params.id,
            String(req.query.token),
            req.params.docId,
          );
        sendDocumentStream(res, file);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  withdrawApplication = [
    param("id").isUUID(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      const token = trackingTokenOf(req);
      if (!token) {
        return sendError(res, HTTP_STATUS.TRACKING_TOKEN_INVALID);
      }
      try {
        const application =
          await organizationApplicationService.withdrawApplication(
            req.params.id,
            token,
          );
        return sendSuccess(res, HTTP_STATUS.OK, { application });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  /* ------------------------------------------------------------------ */
  /* Owner confirmation (public, token in the path)                      */
  /* ------------------------------------------------------------------ */

  getOwnerConfirmation = [
    param("token").notEmpty().isLength({ max: 128 }),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      try {
        const confirmation = await ownerConfirmationService.getSummary(
          req.params.token,
          req.user?.email ?? null,
        );
        return sendSuccess(res, HTTP_STATUS.OK, { confirmation });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  confirmOwner = [
    param("token").notEmpty().isLength({ max: 128 }),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      try {
        const result = await ownerConfirmationService.confirm(
          req.params.token,
          requestMeta(req),
        );
        return sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  declineOwner = [
    param("token").notEmpty().isLength({ max: 128 }),
    body("reason").optional({ values: "null" }).isString().isLength({ max: 1000 }),
    body("blockFuture").optional().isBoolean().toBoolean(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      try {
        const result = await ownerConfirmationService.decline(req.params.token, {
          reason: req.body?.reason ?? null,
          blockFuture: Boolean(req.body?.blockFuture),
        });
        return sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];
}

export const organizationApplicationController =
  new OrganizationApplicationController();
