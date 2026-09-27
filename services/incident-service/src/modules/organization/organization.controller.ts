import { Request, Response } from "express";
import { body, param, query, validationResult } from "express-validator";
import { isURL } from "validator";
import {
  HttpError,
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { GlobalStatus, JoinRequestStatus } from "../../constants/status.enum";
import { OrgMemberRole } from "@da2/constants";
import type {
  ChangeMemberRoleBody,
  AdminVerifyOrganizationBody,
  CreateOrganizationBody,
  GetOrganizationJoinRequestsQuery,
  MyOrganizationJoinRequestsQuery,
  MyOrganizationsListQuery,
  OrganizationListQuery,
  OrganizationMembersListQuery,
  UpdateOrganizationBody,
} from "./organization.dto";
import {
  redirectAfterContactEmailVerified,
  redirectAfterContactEmailVerifyFailed,
} from "./organization-contact-email-urls";
import { verifyAndConsumeOrganizationContactEmailToken } from "./identity-organization-contact-email.client";
import { organizationService } from "./organization.service";

const orgIdParam = param("id").isUUID().withMessage("id must be a valid UUID");
const orgSlugParam = param("slug")
  .trim()
  .notEmpty()
  .isLength({ max: 220 })
  .matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .withMessage("slug must be a URL-friendly lowercase identifier");

function parseOrganizationListEmailVerifiedQuery(
  req: Request,
): boolean | undefined {
  const raw = req.query.isEmailVerified ?? req.query.is_email_verified;
  if (raw === undefined || raw === "") return undefined;
  const s = String(raw).toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return undefined;
}

function parseMyOrganizationsIsOwnerQuery(req: Request): boolean | undefined {
  const raw = req.query.isOwner ?? req.query.is_owner;
  if (raw === undefined || raw === "") return undefined;
  const s = String(raw).toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return undefined;
}

/** Split repeated query params and comma-separated values into trimmed tokens. */
function normalizeOrganizationQueryIntTokens(value: unknown): string[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  const out: string[] = [];
  const pushSplit = (raw: string) => {
    for (const p of raw.split(",")) {
      const t = p.trim();
      if (t) out.push(t);
    }
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== undefined && item !== null && item !== "") {
        pushSplit(String(item));
      }
    }
  } else {
    pushSplit(String(value));
  }
  return out;
}

function assertOptionalQueryIntTokenList(
  value: unknown,
  fieldLabel: string,
): void {
  if (value === undefined || value === null || value === "") {
    return;
  }
  for (const t of normalizeOrganizationQueryIntTokens(value)) {
    if (!/^-?\d+$/.test(t)) {
      throw new Error(`${fieldLabel} must be integer(s)`);
    }
  }
}

function parseOrganizationListOrgStatusQuery(
  req: Request,
): number[] | undefined {
  const tokens = normalizeOrganizationQueryIntTokens(req.query.status);
  if (tokens.length === 0) return undefined;
  return [...new Set(tokens.map((t) => parseInt(t, 10)))];
}

function parseOrganizationListRequestStatusFilterQuery(
  req: Request,
): number[] | undefined {
  const tokens = [
    ...normalizeOrganizationQueryIntTokens(req.query.request_status),
    ...normalizeOrganizationQueryIntTokens(req.query.requestStatus),
  ];
  if (tokens.length === 0) return undefined;
  return [...new Set(tokens.map((t) => parseInt(t, 10)))];
}

/** `roles=OWNER,ADMIN` or repeated `roles=OWNER&roles=ADMIN`; unknown values are dropped. */
function parseRolesQuery(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim().toUpperCase())
    .filter((value) => (Object.values(OrgMemberRole) as string[]).includes(value));
  return values.length ? values : undefined;
}

export class OrganizationController {
  createOrganization = [
    body("name")
      .notEmpty()
      .trim()
      .isLength({ max: 200 })
      .withMessage("name is required (max 200 characters)"),
    body("description")
      .optional()
      .trim()
      .isLength({ max: 5000 })
      .withMessage("description too long"),
    body("descriptionVi").optional().trim().isLength({ max: 5000 }),
    body("descriptionEn").optional().trim().isLength({ max: 5000 }),
    body("lang").optional().isIn(["vi", "en"]),
    body("logoUrl")
      .notEmpty()
      .trim()
      .isLength({ max: 2048 })
      .isURL({ require_tld: false })
      .withMessage(
        "logo_url must be a non-empty valid URL (max 2048 characters)",
      ),
    body("backgroundUrl")
      .optional()
      .trim()
      .isLength({ max: 2048 })
      .isURL({ require_tld: false })
      .withMessage(
        "background_url must be a valid URL (max 2048 characters) when provided",
      ),
    body("contactEmail")
      .notEmpty()
      .trim()
      .isLength({ max: 320 })
      .isEmail()
      .withMessage("contact_email is required and must be a valid email"),
    // Internal callers carry no JWT, so the owner has to be named explicitly.
    body("ownerId")
      .notEmpty()
      .isUUID()
      .withMessage("owner_id is required and must be a uuid"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      const userId = (req.body as { ownerId?: string }).ownerId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      try {
        const body = req.body as CreateOrganizationBody;
        const authz = req.headers.authorization;
        const organization = await organizationService.createOrganization(
          userId,
          body,
          authz,
        );
        return sendSuccess(res, HTTP_STATUS.CREATED, { organization });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  listOrganizations = [
    query("search").optional().trim(),
    query("status")
      .optional()
      .custom((value) => {
        assertOptionalQueryIntTokenList(value, "status");
        return true;
      }),
    query("isEmailVerified").optional().isIn(["true", "false", "1", "0"]),
    query("is_email_verified").optional().isIn(["true", "false", "1", "0"]),
    query("request_status")
      .optional()
      .custom((value) => {
        assertOptionalQueryIntTokenList(value, "request_status");
        return true;
      }),
    query("requestStatus")
      .optional()
      .custom((value) => {
        assertOptionalQueryIntTokenList(value, "requestStatus");
        return true;
      }),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
    query("sortBy").optional().isIn(["createdAt", "updatedAt", "name"]),
    query("sortOrder").optional().isIn(["asc", "desc"]),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      if (!req.user?.userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      const q: OrganizationListQuery = {
        search: req.query.search ? String(req.query.search).trim() : undefined,
        status: parseOrganizationListOrgStatusQuery(req),
        isEmailVerified: parseOrganizationListEmailVerifiedQuery(req),
        requestStatus: parseOrganizationListRequestStatusFilterQuery(req),
        page: req.query.page ? parseInt(String(req.query.page), 10) : undefined,
        limit: req.query.limit
          ? parseInt(String(req.query.limit), 10)
          : undefined,
        sortBy: req.query.sortBy as OrganizationListQuery["sortBy"],
        sortOrder: req.query.sortOrder as OrganizationListQuery["sortOrder"],
      };

      try {
        const result = await organizationService.listOrganizations(
          q,
          req.user.userId,
        );
        return sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  /**
   * Public link from contact email: consumes identity-service auth token, then marks contact confirmed.
   */
  verifyOrganizationContactEmail = [
    query("token").notEmpty().withMessage("token is required"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.redirect(
          302,
          redirectAfterContactEmailVerifyFailed("invalid_or_expired"),
        );
        return;
      }

      const token = String(req.query.token);
      let organizationId: string;
      let email: string;
      try {
        const payload =
          await verifyAndConsumeOrganizationContactEmailToken(token);
        organizationId = payload.organizationId;
        email = payload.contactEmail;
      } catch {
        res.redirect(
          302,
          redirectAfterContactEmailVerifyFailed("invalid_or_expired"),
        );
        return;
      }

      try {
        const verified = await organizationService.confirmOrganizationContactEmail(
          organizationId,
          email,
        );
        res.redirect(302, redirectAfterContactEmailVerified(verified.slug));
      } catch (e) {
        if (HttpError.isHttpError(e)) {
          const status = e.statusResponse.status;
          if (status === 404) {
            res.redirect(
              302,
              redirectAfterContactEmailVerifyFailed("not_found"),
            );
            return;
          }
          if (status === 400) {
            res.redirect(
              302,
              redirectAfterContactEmailVerifyFailed("mismatch"),
            );
            return;
          }
        }
        console.error("verifyOrganizationContactEmail:", e);
        res.redirect(
          302,
          redirectAfterContactEmailVerifyFailed("invalid_or_expired"),
        );
      }
    },
  ];

  listMyOrganizations = [
    query("search").optional().trim(),
    query("status")
      .optional()
      .custom((value) => {
        assertOptionalQueryIntTokenList(value, "status");
        return true;
      }),
    query("isEmailVerified").optional().isIn(["true", "false", "1", "0"]),
    query("is_email_verified").optional().isIn(["true", "false", "1", "0"]),
    query("request_status")
      .optional()
      .custom((value) => {
        assertOptionalQueryIntTokenList(value, "request_status");
        return true;
      }),
    query("requestStatus")
      .optional()
      .custom((value) => {
        assertOptionalQueryIntTokenList(value, "requestStatus");
        return true;
      }),
    query("is_owner").optional().isIn(["true", "false", "1", "0"]),
    query("isOwner").optional().isIn(["true", "false", "1", "0"]),
    query("roles").optional(),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
    query("sortBy").optional().isIn(["createdAt", "updatedAt", "name"]),
    query("sortOrder").optional().isIn(["asc", "desc"]),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      const q: MyOrganizationsListQuery = {
        search: req.query.search ? String(req.query.search).trim() : undefined,
        status: parseOrganizationListOrgStatusQuery(req),
        isEmailVerified: parseOrganizationListEmailVerifiedQuery(req),
        requestStatus: parseOrganizationListRequestStatusFilterQuery(req),
        isOwner: parseMyOrganizationsIsOwnerQuery(req),
        roles: parseRolesQuery(req.query.roles),
        page: req.query.page ? parseInt(String(req.query.page), 10) : undefined,
        limit: req.query.limit
          ? parseInt(String(req.query.limit), 10)
          : undefined,
        sortBy: req.query.sortBy as MyOrganizationsListQuery["sortBy"],
        sortOrder: req.query.sortOrder as MyOrganizationsListQuery["sortOrder"],
      };

      try {
        const result = await organizationService.listMyOrganizations(userId, q);
        return sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  /**
   * Approve or ban an organization (admin only) via body `status`:
   * `GlobalStatus._STATUS_ACTIVE` (1) to verify, `_STATUS_INACTIVE` (2) to ban.
   * Ban requires `reject_reason`; verify may omit it (clears any previous reason).
   */
  adminVerifyOrganization = [
    orgIdParam,
    body("status")
      .isInt()
      .toInt()
      .isIn([GlobalStatus._STATUS_ACTIVE, GlobalStatus._STATUS_INACTIVE])
      .withMessage(
        "status must be 1 (active) to verify or 2 (inactive) to ban",
      ),
    body("rejectReason").custom((value, { req }) => {
      const status = Number(req.body.status);
      const isBan = status === GlobalStatus._STATUS_INACTIVE;
      if (value === undefined || value === null) {
        if (isBan) {
          throw new Error(
            "reject_reason is required when banning an organization",
          );
        }
        return true;
      }
      if (typeof value !== "string") {
        throw new Error("reject_reason must be a string or null");
      }
      const trimmed = value.trim();
      if (isBan && !trimmed) {
        throw new Error(
          "reject_reason is required when banning an organization",
        );
      }
      if (trimmed.length > 5000) {
        throw new Error("reject_reason too long (max 5000 characters)");
      }
      return true;
    }),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      const role = req.user?.role;
      const normalizedRole = role?.toLowerCase();
      if (!normalizedRole || normalizedRole !== "admin") {
        return sendError(
          res,
          HTTP_STATUS.FORBIDDEN.withMessage(
            "Only admin can verify an organization",
          ),
        );
      }

      const { status, rejectReason } = req.body as AdminVerifyOrganizationBody;

      try {
        const organization = await organizationService.adminVerifyOrganization(
          req.params.id,
          userId,
          status,
          rejectReason,
        );
        const message =
          status === GlobalStatus._STATUS_ACTIVE
            ? "Organization verified successfully"
            : "Organization banned successfully";
        return sendSuccess(res, HTTP_STATUS.OK.withMessage(message), {
          organization,
        });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  updateOrganization = [
    orgIdParam,
    body("name")
      .optional()
      .trim()
      .isLength({ min: 1, max: 200 })
      .withMessage("name must be 1–200 characters when provided"),
    body("description")
      .optional()
      .trim()
      .isLength({ max: 5000 })
      .withMessage("description too long"),
    body("descriptionVi").optional().trim().isLength({ max: 5000 }),
    body("descriptionEn").optional().trim().isLength({ max: 5000 }),
    body("lang").optional().isIn(["vi", "en"]),
    body("logoUrl")
      .optional()
      .trim()
      .isLength({ max: 2048 })
      .isURL({ require_tld: false })
      .withMessage("logo_url must be a valid URL (max 2048 characters)"),
    body("backgroundUrl")
      .optional({ nullable: true })
      .custom((value) => {
        if (value === null) {
          return true;
        }
        if (typeof value !== "string") {
          throw new Error("background_url must be a string or null");
        }
        const t = value.trim();
        if (!t) {
          throw new Error(
            "background_url must be a non-empty valid URL or null to clear",
          );
        }
        if (t.length > 2048) {
          throw new Error("background_url must be at most 2048 characters");
        }
        if (!isURL(t, { require_tld: false })) {
          throw new Error("background_url must be a valid URL");
        }
        return true;
      }),
    body("contactEmail")
      .optional()
      .trim()
      .isLength({ max: 320 })
      .isEmail()
      .withMessage("contact_email must be a valid email"),
    body().custom((_value, { req }) => {
      const b = req.body as Record<string, unknown>;
      const has =
        b.name !== undefined ||
        b.description !== undefined ||
        b.descriptionVi !== undefined ||
        b.descriptionEn !== undefined ||
        b.logoUrl !== undefined ||
        b.backgroundUrl !== undefined ||
        b.contactEmail !== undefined;
      if (!has) {
        throw new Error(
          "At least one of name, description, logo_url, background_url, contact_email is required",
        );
      }
      return true;
    }),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      try {
        const body = req.body as UpdateOrganizationBody;
        const authz = req.headers.authorization;
        const organization = await organizationService.updateOrganization(
          req.params.id,
          userId,
          body,
          authz,
        );
        return sendSuccess(res, HTTP_STATUS.OK, { organization });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  resendOrganizationContactEmail = [
    orgIdParam,

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      try {
        const organization =
          await organizationService.resendOrganizationContactVerificationEmail(
            req.params.id,
            userId,
          );
        return sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Verification email sent"),
          { organization },
        );
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  getOrganizationById = [
    orgIdParam,

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      if (!req.user?.userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      try {
        const organization = await organizationService.getById(
          req.params.id,
          req.user.userId,
        );
        if (!organization) {
          return sendError(res, HTTP_STATUS.NOT_FOUND);
        }
        return sendSuccess(res, HTTP_STATUS.OK, { organization });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  getOrganizationBySlug = [
    orgSlugParam,

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      if (!req.user?.userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      try {
        const organization = await organizationService.getBySlug(
          req.params.slug,
          req.user.userId,
        );
        if (!organization) {
          return sendError(
            res,
            HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"),
          );
        }
        return sendSuccess(res, HTTP_STATUS.OK, { organization });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  createJoinRequest = [
    orgIdParam,

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      try {
        const joinRequest = await organizationService.createJoinRequest(
          req.params.id,
          userId,
        );
        return sendSuccess(res, HTTP_STATUS.CREATED, { joinRequest });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  listJoinRequestsForOwner = [
    orgIdParam,
    query("status").optional().isInt(),
    query("requesterId").optional().isUUID(),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
    query("sortBy").optional().isIn(["createdAt", "updatedAt"]),
    query("sortOrder").optional().isIn(["asc", "desc"]),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      const q: GetOrganizationJoinRequestsQuery = {
        status:
          req.query.status !== undefined && req.query.status !== ""
            ? parseInt(String(req.query.status), 10)
            : undefined,
        requesterId: req.query.requesterId
          ? String(req.query.requesterId).trim()
          : undefined,
        page: req.query.page ? parseInt(String(req.query.page), 10) : undefined,
        limit: req.query.limit
          ? parseInt(String(req.query.limit), 10)
          : undefined,
        sortBy: req.query.sortBy as GetOrganizationJoinRequestsQuery["sortBy"],
        sortOrder: req.query
          .sortOrder as GetOrganizationJoinRequestsQuery["sortOrder"],
      };

      try {
        const result = await organizationService.listJoinRequestsForOwner(
          req.params.id,
          userId,
          q,
        );
        return sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  getMyJoinRequests = [
    query("organizationId").optional().isUUID(),
    query("status").optional().isInt(),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
    query("sortBy").optional().isIn(["createdAt", "updatedAt"]),
    query("sortOrder").optional().isIn(["asc", "desc"]),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      const q: MyOrganizationJoinRequestsQuery = {
        organizationId: req.query.organizationId
          ? String(req.query.organizationId).trim()
          : undefined,
        status:
          req.query.status !== undefined && req.query.status !== ""
            ? parseInt(String(req.query.status), 10)
            : undefined,
        page: req.query.page ? parseInt(String(req.query.page), 10) : undefined,
        limit: req.query.limit
          ? parseInt(String(req.query.limit), 10)
          : undefined,
        sortBy: req.query.sortBy as MyOrganizationJoinRequestsQuery["sortBy"],
        sortOrder: req.query
          .sortOrder as MyOrganizationJoinRequestsQuery["sortOrder"],
      };

      try {
        const result = await organizationService.getMyJoinRequests(userId, q);
        return sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  processJoinRequest = [
    body("requestId").isUUID().withMessage("requestId must be a valid UUID"),
    body("approved").isBoolean().withMessage("approved must be boolean"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      const status = req.body.approved
        ? JoinRequestStatus._STATUS_APPROVED
        : JoinRequestStatus._STATUS_REJECTED;

      try {
        const joinRequest = await organizationService.processJoinRequest(
          req.body.requestId,
          userId,
          status,
        );
        return sendSuccess(res, HTTP_STATUS.OK, { joinRequest });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  cancelJoinRequest = [
    body("requestId").isUUID().withMessage("requestId must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      try {
        await organizationService.cancelJoinRequest(req.body.requestId, userId);
        return sendSuccess(res, HTTP_STATUS.OK);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  leaveOrganization = [
    orgIdParam,

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      try {
        await organizationService.leaveOrganization(req.params.id, userId);
        return sendSuccess(res, HTTP_STATUS.OK);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  changeMemberRole = [
    orgIdParam,
    param("userId").isUUID(),
    body("role")
      .isIn(Object.values(OrgMemberRole))
      .withMessage("role must be an OrgMemberRole"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }
      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }
      try {
        const member = await organizationService.changeMemberRole(
          req.params.id,
          userId,
          req.params.userId,
          String((req.body as ChangeMemberRoleBody).role),
        );
        return sendSuccess(res, HTTP_STATUS.OK, { member });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  removeMember = [
    orgIdParam,
    param("userId").isUUID(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }
      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }
      try {
        await organizationService.removeMember(
          req.params.id,
          userId,
          req.params.userId,
        );
        return sendSuccess(res, HTTP_STATUS.OK);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  listMembers = [
    orgIdParam,
    query("userId").optional().isUUID(),
    query("user_id").optional().isUUID(),
    query("search").optional().isString().trim(),
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("sortBy").optional().isIn(["createdAt", "updatedAt"]),
    query("sort_by").optional().isIn(["created_at", "updated_at"]),
    query("sortOrder").optional().isIn(["asc", "desc"]),
    query("sort_order").optional().isIn(["asc", "desc"]),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      const memberUserId =
        (req.query.userId as string | undefined)?.trim() ||
        (req.query.user_id as string | undefined)?.trim();

      const sortByRaw = req.query.sortBy ?? req.query.sort_by;
      let sortBy: OrganizationMembersListQuery["sortBy"] = "createdAt";
      if (sortByRaw === "updatedAt" || sortByRaw === "updated_at") {
        sortBy = "updatedAt";
      }

      const sortOrderRaw = req.query.sortOrder ?? req.query.sort_order;
      const sortOrder: OrganizationMembersListQuery["sortOrder"] =
        sortOrderRaw === "asc" ? "asc" : "desc";

      const searchRaw = req.query.search;
      const q: OrganizationMembersListQuery = {
        userId: memberUserId || undefined,
        search:
          searchRaw !== undefined && String(searchRaw).trim().length > 0
            ? String(searchRaw).trim()
            : undefined,
        page: req.query.page as number | undefined,
        limit: req.query.limit as number | undefined,
        sortBy,
        sortOrder,
      };

      try {
        const result = await organizationService.listMembersForOwner(
          req.params.id,
          // userId,
          q,
        );
        return sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];
}

export const organizationController = new OrganizationController();
