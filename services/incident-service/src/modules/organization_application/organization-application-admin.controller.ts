import { Request, Response } from "express";
import { body, param, query, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import {
  ApplicationDecisionBody,
  RequestMoreInfoBody,
} from "./organization-application.dto";
import { organizationApplicationAdminService } from "./organization-application-admin.service";
import { sendDocumentStream } from "./document-stream";

/**
 * Resolves the caller and refuses anyone who is not an admin. Mirrors the inline check in
 * `organization.controller.ts`; this service has no role-guard middleware.
 *
 * NOTE: the spec reserves trust-tier changes for a super-admin, but identity-service only
 * seeds ADMIN and USER. Until a super-admin role exists, ADMIN covers both.
 */
function requireAdmin(req: Request, res: Response): string | null {
  const userId = req.user?.userId;
  if (!userId) {
    sendError(res, HTTP_STATUS.UNAUTHORIZED);
    return null;
  }
  if (req.user?.role?.toLowerCase() !== "admin") {
    sendError(
      res,
      HTTP_STATUS.FORBIDDEN.withMessage(
        "Only admin can review organization applications",
      ),
    );
    return null;
  }
  return userId;
}

function failedValidation(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
  return true;
}

/** Accepts `?status=A&status=B` as well as `?status=A,B` — query strings are not camelized. */
function listTokens(...values: unknown[]): string[] | undefined {
  const tokens = values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  return tokens.length ? [...new Set(tokens)] : undefined;
}

export class OrganizationApplicationAdminController {
  listApplications = [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      if (!requireAdmin(req, res)) return;
      try {
        const result = await organizationApplicationAdminService.list({
          status: listTokens(req.query.status),
          orgType: listTokens(req.query.org_type, req.query.orgType),
          lane: listTokens(req.query.lane),
          q: typeof req.query.q === "string" ? req.query.q.trim() : undefined,
          page: Number(req.query.page ?? 1),
          limit: Number(req.query.limit ?? 20),
        });
        return sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  getApplication = [
    param("id").isUUID(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      if (!requireAdmin(req, res)) return;
      try {
        const application = await organizationApplicationAdminService.getById(
          req.params.id,
        );
        return sendSuccess(res, HTTP_STATUS.OK, { application });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  /** Streams the stored file; the provider URL is never exposed to the browser. */
  openDocument = [
    param("id").isUUID(),
    param("docId").isUUID(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      const adminUserId = requireAdmin(req, res);
      if (!adminUserId) return;
      try {
        const file = await organizationApplicationAdminService.openDocument(
          req.params.id,
          req.params.docId,
          adminUserId,
        );
        sendDocumentStream(res, file);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  claimApplication = [
    param("id").isUUID(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      const adminUserId = requireAdmin(req, res);
      if (!adminUserId) return;
      try {
        const application = await organizationApplicationAdminService.claim(
          req.params.id,
          adminUserId,
        );
        return sendSuccess(res, HTTP_STATUS.OK, { application });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  requestMoreInfo = [
    param("id").isUUID(),
    body("message").notEmpty().trim().isLength({ max: 5000 }),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      const adminUserId = requireAdmin(req, res);
      if (!adminUserId) return;
      try {
        const { message } = req.body as RequestMoreInfoBody;
        const application =
          await organizationApplicationAdminService.requestMoreInfo(
            req.params.id,
            adminUserId,
            message,
          );
        return sendSuccess(res, HTTP_STATUS.OK, { application });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];

  decideApplication = [
    param("id").isUUID(),
    body("decision").notEmpty().trim(),
    body("lane").optional().trim().isLength({ max: 1 }),
    body("documentsWaived").optional().isBoolean().toBoolean(),
    body("documentsWaivedReason").optional().trim().isLength({ max: 5000 }),
    body("rejectReason").optional().trim().isLength({ max: 5000 }),
    body("grantBlueTick").optional().isBoolean().toBoolean(),

    async (req: Request, res: Response): Promise<void> => {
      if (failedValidation(req, res)) return;
      const adminUserId = requireAdmin(req, res);
      if (!adminUserId) return;
      try {
        const application = await organizationApplicationAdminService.decide(
          req.params.id,
          adminUserId,
          req.body as ApplicationDecisionBody,
        );
        return sendSuccess(res, HTTP_STATUS.OK, { application });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        throw error;
      }
    },
  ];
}

export const organizationApplicationAdminController =
  new OrganizationApplicationAdminController();
