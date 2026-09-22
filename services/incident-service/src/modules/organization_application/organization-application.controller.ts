import { Request, Response } from "express";
import { body, param, query, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import {
  CreateApplicationBody,
  PresignApplicationDocumentBody,
  RequestApplicationOtpBody,
  UpdateApplicationBody,
  VerifyApplicationOtpBody,
} from "./organization-application.dto";
import { organizationApplicationOtpService } from "./organization-application-otp.service";
import { organizationApplicationService } from "./organization-application.service";

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
        const { expiresAt } =
          await organizationApplicationOtpService.requestOtp(email);
        return sendSuccess(res, HTTP_STATUS.OK, {
          sent: true,
          expiresAt: expiresAt.toISOString(),
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
        const result = await organizationApplicationOtpService.verifyOtp(
          email,
          otp,
        );
        return sendSuccess(res, HTTP_STATUS.OK, {
          submissionToken: result.submissionToken,
          expiresAt: result.expiresAt.toISOString(),
        });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  /* ------------------------------------------------------------------ */
  /* P1 — documents                                                      */
  /* ------------------------------------------------------------------ */

  presignDocument = [
    body("docType").notEmpty().trim().isLength({ max: 32 }),
    body("fileName").notEmpty().trim().isLength({ max: 255 }),
    body("mimeType").notEmpty().trim().isLength({ max: 100 }),
    body("sizeBytes").isInt({ min: 1 }).toInt(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      const submissionEmail = req.submissionEmail;
      if (!submissionEmail) {
        return sendError(res, HTTP_STATUS.SUBMISSION_TOKEN_INVALID);
      }
      try {
        const input = req.body as PresignApplicationDocumentBody;
        const result = await organizationApplicationService.presignDocument(
          submissionEmail,
          input,
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

  createApplication = [
    body("orgType").notEmpty().trim().isLength({ max: 32 }),
    body("profile").isObject().withMessage("profile is required"),
    body("channels").isArray({ min: 1 }).withMessage("channels is required"),
    body("documentIds").optional().isArray({ max: 5 }),
    body("documentIds.*").optional().isUUID(),
    body("consent").isBoolean().toBoolean(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      const submissionEmail = req.submissionEmail;
      const submissionToken = req.submissionToken;
      if (!submissionEmail || !submissionToken) {
        return sendError(res, HTTP_STATUS.SUBMISSION_TOKEN_INVALID);
      }
      try {
        const application =
          await organizationApplicationService.createApplication(
            submissionEmail,
            submissionToken,
            req.body as CreateApplicationBody,
            req.user?.userId,
          );
        return sendSuccess(res, HTTP_STATUS.CREATED, { application });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

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

  updateApplication = [
    param("id").isUUID(),
    body("orgType").optional().trim().isLength({ max: 32 }),
    body("profile").optional().isObject(),
    body("channels").optional().isArray({ min: 1 }),
    body("documentIds").optional().isArray({ max: 5 }),
    body("documentIds.*").optional().isUUID(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      const token = String(req.query.token ?? (req.body as UpdateApplicationBody).token ?? "");
      if (!token) {
        return sendError(res, HTTP_STATUS.SUBMISSION_TOKEN_INVALID);
      }
      try {
        const application =
          await organizationApplicationService.updateApplication(
            req.params.id,
            token,
            req.body as UpdateApplicationBody,
          );
        return sendSuccess(res, HTTP_STATUS.OK, { application });
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
      const token = String(req.query.token ?? req.body?.token ?? "");
      if (!token) {
        return sendError(res, HTTP_STATUS.SUBMISSION_TOKEN_INVALID);
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
}

export const organizationApplicationController =
  new OrganizationApplicationController();
