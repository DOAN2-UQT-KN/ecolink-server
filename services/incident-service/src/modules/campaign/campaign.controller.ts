import { Request, Response } from "express";
import { body, param, query, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { campaignService } from "./campaign.service";
import { campaignManagerService } from "./campaign_manager/campaign_manager.service";
import { campaignTaskService } from "./campaign_task/campaign_task.service";
import { campaignRegistrationService } from "./campaign_registration/campaign_registration.service";
import { campaignAttendanceService } from "./campaign_attendance/campaign_attendance.service";
import { GlobalStatus } from "../../constants/status.enum";
import {
  CAMPAIGN_DIFFICULTY_MAX,
  CAMPAIGN_DIFFICULTY_MIN,
  CAMPAIGN_DAY_MAX,
  CAMPAIGN_MEETING_POINT_MAX,
  CAMPAIGN_REVIEW_REASON_MAX_LENGTH,
} from "@da2/constants";
import { isPlatformAdmin } from "./campaign-access.service";
import { campaignEligibilityService } from "./campaign-eligibility.service";
import { campaignLifecycleService } from "./campaign-lifecycle.service";
import type {
  AdminCompletionReviewBody,
  AdminReviewCampaignBody,
  AdminVerifyCampaignBody,
  CampaignListQuery,
  CampaignManagersListQuery,
  CampaignMultiSubmissionReviewListQuery,
} from "./campaign.dto";
import { normalizeQueryUuidList } from "../../utils/query-uuid-list";
import { resolveRequestLocale } from "../../utils/resolve-request-locale";

const CAMPAIGN_BATCH_QUERY_MAX_IDS = 100;

/**
 * Shape checks for the fields added with drafts and meeting points. Business rules (lengths,
 * dates, distances, volunteer numbers) run on submit, so a draft can be saved half-filled.
 */
const campaignDetailValidators = () => [
  body("contactName")
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 120 })
    .withMessage("contactName must be at most 120 characters")
    .trim(),
  body("contactPhone")
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 20 })
    .withMessage("contactPhone must be at most 20 characters")
    .trim(),
  body("safetyNotes").optional({ nullable: true }).isString().trim(),
  body("requirements")
    .optional({ nullable: true })
    .isObject()
    .withMessage("requirements must be an object"),
  body("requirements.minAge")
    .optional({ nullable: true })
    .isInt({ min: 0, max: 100 })
    .withMessage("requirements.minAge must be 0–100"),
  body("requirements.skills")
    .optional()
    .isArray({ max: 20 })
    .withMessage("requirements.skills must be an array"),
  body("requirements.skills.*").optional().isString().isLength({ max: 100 }),
  body("requirements.bringOwnTools").optional().isBoolean(),
  body("meetingPoints")
    .optional()
    .isArray({ max: CAMPAIGN_MEETING_POINT_MAX })
    .withMessage(`meetingPoints must be an array of at most ${CAMPAIGN_MEETING_POINT_MAX}`),
  body("meetingPoints.*.id").optional().isUUID(),
  body("meetingPoints.*.name")
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 120 }),
  body("meetingPoints.*.latitude")
    .isFloat({ min: -90, max: 90 })
    .withMessage("meeting point latitude must be between -90 and 90"),
  body("meetingPoints.*.longitude")
    .isFloat({ min: -180, max: 180 })
    .withMessage("meeting point longitude must be between -180 and 180"),
  body("meetingPoints.*.radiusKm")
    .isFloat({ min: 0 })
    .withMessage("meeting point radiusKm must be a non-negative number"),
  body("meetingPoints.*.detailAddress")
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 255 }),
  body("meetingPoints.*.reportIds").optional().isArray(),
  body("meetingPoints.*.reportIds.*").isUUID(),
  body(["startDate", "endDate"])
    .not()
    .exists()
    .withMessage("startDate and endDate were replaced by days"),
  body("days")
    .optional()
    .isArray({ max: CAMPAIGN_DAY_MAX })
    .withMessage(`days must be an array of at most ${CAMPAIGN_DAY_MAX}`),
  body("days.*.id").optional().isUUID(),
  body("days.*.startAt").isISO8601().withMessage("day startAt must be an ISO 8601 datetime"),
  body("days.*.endAt").isISO8601().withMessage("day endAt must be an ISO 8601 datetime"),
  body("shifts")
    .optional()
    .isArray({ max: CAMPAIGN_DAY_MAX * CAMPAIGN_MEETING_POINT_MAX })
    .withMessage("shifts must be an array"),
  body("shifts.*.dayIndex").isInt({ min: 0, max: CAMPAIGN_DAY_MAX - 1 }),
  body("shifts.*.meetingPointIndex").isInt({ min: 0, max: CAMPAIGN_MEETING_POINT_MAX - 1 }),
  body("shifts.*.minVolunteers")
    .isInt({ min: 0 })
    .withMessage("shift minVolunteers must be a whole number ≥ 0"),
  body("shifts.*.maxVolunteers")
    .optional({ nullable: true })
    .isInt({ min: 1 })
    .withMessage("shift maxVolunteers must be a whole number ≥ 1"),
  body("minVolunteersReason")
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 1000 })
    .withMessage("minVolunteersReason must be at most 1000 characters"),
  body("shifts.*.startAt").optional({ nullable: true }).isISO8601(),
  body("shifts.*.endAt").optional({ nullable: true }).isISO8601(),
  body("shifts.*.gatherAt").optional({ nullable: true }).isISO8601(),
  body("shifts.*.leaderUserId").optional({ nullable: true }).isUUID(),
];

export class CampaignController {
  constructor() {}

  private parseStatusesQuery(raw: unknown): number[] | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }

    const source = Array.isArray(raw) ? raw.join(",") : String(raw);
    const trimmed = source.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const parsed = trimmed
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .map((value) => Number(value));

    if (parsed.length === 0 || parsed.some((value) => !Number.isInteger(value))) {
      throw new Error("statuses must be a comma-separated list of integers");
    }

    return [...new Set(parsed)];
  }

  createCampaign = [
    body("organizationId")
      .isUUID()
      .withMessage("organizationId must be a valid UUID"),
    body("title").notEmpty().withMessage("Title is required").trim(),
    body("banner")
      .optional()
      .isString()
      .isLength({ max: 2048 })
      .withMessage("banner must be at most 2048 characters")
      .trim(),
    body("description").optional().trim(),
    body("difficulty")
      .isInt({ min: CAMPAIGN_DIFFICULTY_MIN, max: CAMPAIGN_DIFFICULTY_MAX })
      .withMessage(
        `difficulty must be between ${CAMPAIGN_DIFFICULTY_MIN} and ${CAMPAIGN_DIFFICULTY_MAX}`,
      ),
    ...campaignDetailValidators(),
    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const campaign = await campaignService.createCampaign(userId, req.body);
        sendSuccess(res, HTTP_STATUS.CREATED, { campaign });
      } catch (error) {
        console.error("Create campaign error:", error);
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        if (error instanceof Error) {
          if (error.message.includes("reportIds")) {
            return sendError(
              res,
              HTTP_STATUS.BAD_REQUEST.withMessage(error.message),
            );
          }
          if (
            error.message.includes("REWARD_SERVICE_URL") ||
            error.message.includes("INTERNAL_REWARD_API_KEY")
          ) {
            return sendError(
              res,
              HTTP_STATUS.INTERNAL_SERVER_ERROR.withMessage(error.message),
            );
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  getCampaigns = [
    query("search").optional().trim(),
    query("status").optional().isInt(),
    query("statuses")
      .optional()
      .custom((value) => {
        const source = Array.isArray(value) ? value.join(",") : String(value ?? "");
        if (source.trim().length === 0) return true;
        return source
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .every((item) => /^-?\d+$/.test(item));
      })
      .withMessage("statuses must be a comma-separated list of integers"),
    query("createdBy").optional().isUUID(),
    query("managerId").optional().isUUID(),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
    query("sortBy").optional().isIn(["createdAt", "updatedAt", "title"]),
    query("sortOrder").optional().isIn(["asc", "desc"]),
    query("organizationId").optional().isUUID(),
    query("latitude").optional().isFloat({ min: -90, max: 90 }),
    query("longitude").optional().isFloat({ min: -180, max: 180 }),
    query("radiusKm").optional().isFloat({ min: 0 }),
    query("difficulty").optional().isInt({ min: 1 }),
    query("greenPointsFrom").optional().isInt({ min: 0 }),
    query("greenPointsTo").optional().isInt({ min: 0 }),
    query("excludeMemberOrgs").optional().isBoolean(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const isAdmin = isPlatformAdmin(req.user?.role);
        const q: CampaignListQuery = {
          // Drafts and campaigns under review, blocked or expired are admin-only here;
          // their managers find them under GET /campaigns/my.
          publicOnly: !isAdmin,
          excludeDrafts: true,
          excludeMemberOrgsOfUserId:
            isAdmin && String(req.query.excludeMemberOrgs) === "true"
              ? req.user?.userId
              : undefined,
          lang: resolveRequestLocale(req),
          search: req.query.search
            ? String(req.query.search).trim()
            : undefined,
          page: req.query.page
            ? parseInt(String(req.query.page), 10)
            : undefined,
          limit: req.query.limit
            ? parseInt(String(req.query.limit), 10)
            : undefined,
          status:
            req.query.status !== undefined && req.query.status !== ""
              ? parseInt(String(req.query.status), 10)
              : undefined,
          statuses: this.parseStatusesQuery(req.query.statuses),
          createdBy: req.query.createdBy
            ? String(req.query.createdBy).trim()
            : undefined,
          managerId: req.query.managerId
            ? String(req.query.managerId).trim()
            : undefined,
          organizationId: req.query.organizationId
            ? String(req.query.organizationId).trim()
            : undefined,
          latitude: req.query.latitude
            ? parseFloat(String(req.query.latitude))
            : undefined,
          longitude: req.query.longitude
            ? parseFloat(String(req.query.longitude))
            : undefined,
          radiusKm: req.query.radiusKm
            ? parseFloat(String(req.query.radiusKm))
            : undefined,
          difficulty: req.query.difficulty
            ? parseInt(String(req.query.difficulty), 10)
            : undefined,
          greenPointsFrom: req.query.greenPointsFrom
            ? parseInt(String(req.query.greenPointsFrom), 10)
            : undefined,
          greenPointsTo: req.query.greenPointsTo
            ? parseInt(String(req.query.greenPointsTo), 10)
            : undefined,
          sortBy: req.query.sortBy as CampaignListQuery["sortBy"],
          sortOrder: req.query.sortOrder as CampaignListQuery["sortOrder"],
        };

        const result = await campaignService.listCampaigns(q, req.user?.userId);
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Get campaigns error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * All campaigns with status ACTIVE (no pagination).
   */
  getAllActiveCampaigns = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const result = await campaignService.getAllActiveCampaigns(
        req.user?.userId,
      );
      sendSuccess(res, HTTP_STATUS.OK, result);
    } catch (error) {
      console.error("Get all active campaigns error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

  getMyCampaigns = [
    query("search").optional().trim(),
    query("status").optional().isInt(),
    query("statuses")
      .optional()
      .custom((value) => {
        const source = Array.isArray(value) ? value.join(",") : String(value ?? "");
        if (source.trim().length === 0) return true;
        return source
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .every((item) => /^-?\d+$/.test(item));
      })
      .withMessage("statuses must be a comma-separated list of integers"),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
    query("sortBy").optional().isIn(["createdAt", "updatedAt", "title"]),
    query("sortOrder").optional().isIn(["asc", "desc"]),
    query("organizationId").optional().isUUID(),
    query("latitude").optional().isFloat({ min: -90, max: 90 }),
    query("longitude").optional().isFloat({ min: -180, max: 180 }),
    query("radiusKm").optional().isFloat({ min: 0 }),
    query("difficulty").optional().isInt({ min: 1 }),
    query("greenPointsFrom").optional().isInt({ min: 0 }),
    query("greenPointsTo").optional().isInt({ min: 0 }),
    query("is_owner").optional().isBoolean(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const q: CampaignListQuery = {
          lang: resolveRequestLocale(req),
          search: req.query.search
            ? String(req.query.search).trim()
            : undefined,
          page: req.query.page
            ? parseInt(String(req.query.page), 10)
            : undefined,
          limit: req.query.limit
            ? parseInt(String(req.query.limit), 10)
            : undefined,
          status:
            req.query.status !== undefined && req.query.status !== ""
              ? parseInt(String(req.query.status), 10)
              : undefined,
          statuses: this.parseStatusesQuery(req.query.statuses),
          organizationId: req.query.organizationId
            ? String(req.query.organizationId).trim()
            : undefined,
          latitude: req.query.latitude
            ? parseFloat(String(req.query.latitude))
            : undefined,
          longitude: req.query.longitude
            ? parseFloat(String(req.query.longitude))
            : undefined,
          radiusKm: req.query.radiusKm
            ? parseFloat(String(req.query.radiusKm))
            : undefined,
          difficulty: req.query.difficulty
            ? parseInt(String(req.query.difficulty), 10)
            : undefined,
          greenPointsFrom: req.query.greenPointsFrom
            ? parseInt(String(req.query.greenPointsFrom), 10)
            : undefined,
          greenPointsTo: req.query.greenPointsTo
            ? parseInt(String(req.query.greenPointsTo), 10)
            : undefined,
          isOwner: req.query.is_owner !== undefined
            ? String(req.query.is_owner).toLowerCase() === "true"
            : undefined,
          sortBy: req.query.sortBy as CampaignListQuery["sortBy"],
          sortOrder: req.query.sortOrder as CampaignListQuery["sortOrder"],
        };

        const result = await campaignService.getMyCampaigns(q, userId);
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Get my campaigns error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * @query campaignIds — required; comma-separated or repeated; max 100 UUIDs
   */
  getCampaignsByIds = [
    async (req: Request, res: Response): Promise<void> => {
      const campaignParsed = normalizeQueryUuidList(
        req.query.campaignIds,
        CAMPAIGN_BATCH_QUERY_MAX_IDS,
      );

      if (campaignParsed.kind === "invalid") {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: [
            {
              msg: `campaignIds must be valid UUIDs with at most ${CAMPAIGN_BATCH_QUERY_MAX_IDS} values (comma-separated or repeated keys)`,
              path: "query",
            },
          ],
        });
      }

      if (campaignParsed.kind === "absent" || campaignParsed.ids.length === 0) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: [
            {
              msg: "campaignIds is required",
              path: "query",
            },
          ],
        });
      }

      try {
        const campaigns = await campaignService.getCampaignsByIds(
          campaignParsed.ids,
          req.user?.userId,
          resolveRequestLocale(req),
          req.user?.role,
        );
        sendSuccess(res, HTTP_STATUS.OK, { campaigns });
      } catch (error) {
        console.error("Get campaigns by ids error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  getCampaignById = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const campaign = await campaignService.getCampaignById(
          req.params.id,
          req.user?.userId,
          resolveRequestLocale(req),
          req.user?.role,
        );
        if (!campaign) {
          return sendError(
            res,
            HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
          );
        }

        sendSuccess(res, HTTP_STATUS.OK, { campaign });
      } catch (error) {
        console.error("Get campaign error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /** Whether the caller may create a campaign for an organization, and why not. */
  getCreateEligibility = [
    query("organizationId")
      .isUUID()
      .withMessage("organizationId must be a valid UUID"),
    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }
      const userId = req.user?.userId;
      if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      try {
        const eligibility = await campaignEligibilityService.get(
          userId,
          String(req.query.organizationId),
        );
        sendSuccess(res, HTTP_STATUS.OK, { eligibility });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        console.error("Campaign eligibility error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /** Send a draft, or a campaign waiting for changes, for admin review. */
  submitCampaign = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }
      const userId = req.user?.userId;
      if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      try {
        const campaign = await campaignService.submitCampaign(
          req.params.id,
          userId,
        );
        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Campaign sent for review"),
          { campaign },
        );
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        console.error("Submit campaign error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /** Admin: approve, request changes to, or block a campaign waiting for review. */
  reviewCampaign = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    body("decision")
      .isIn(["approve", "request_revision", "block"])
      .withMessage("decision must be approve, request_revision or block"),
    body("reason")
      .optional({ nullable: true })
      .isString()
      .isLength({ max: CAMPAIGN_REVIEW_REASON_MAX_LENGTH })
      .withMessage(
        `reason must be at most ${CAMPAIGN_REVIEW_REASON_MAX_LENGTH} characters`,
      ),
    body("reason").custom((value, { req }) => {
      if (req.body.decision !== "approve" && !String(value ?? "").trim()) {
        throw new Error("reason is required to request changes or block");
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
      if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      if (!isPlatformAdmin(req.user?.role)) {
        return sendError(
          res,
          HTTP_STATUS.FORBIDDEN.withMessage("Only admin can review a campaign"),
        );
      }
      const { decision, reason } = req.body as AdminReviewCampaignBody;
      try {
        const campaign = await campaignService.reviewCampaign(
          req.params.id,
          userId,
          decision,
          reason,
        );
        sendSuccess(res, HTTP_STATUS.OK, { campaign });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        console.error("Review campaign error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /** Status changes and edits under review (managers and admins). */
  getCampaignHistory = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }
      const userId = req.user?.userId;
      if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      try {
        const history = await campaignLifecycleService.getHistory(
          req.params.id,
          userId,
          req.user?.role,
        );
        sendSuccess(res, HTTP_STATUS.OK, { history });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        console.error("Campaign history error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Approve or ban a campaign (admin only) via body `status`:
   * `GlobalStatus._STATUS_ACTIVE` (1) to verify, `_STATUS_INACTIVE` (2) to ban.
   * Ban requires `reject_reason`; verify may omit it (clears any previous reason).
   */
  adminVerifyCampaign = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
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
            "reject_reason is required when banning a campaign",
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
          "reject_reason is required when banning a campaign",
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
            "Only admin can verify a campaign",
          ),
        );
      }

      const { status, rejectReason } = req.body as AdminVerifyCampaignBody;

      try {
        const campaign = await campaignService.adminVerifyCampaign(
          req.params.id,
          userId,
          status,
          rejectReason,
        );
        const message =
          status === GlobalStatus._STATUS_ACTIVE
            ? "Campaign verified successfully"
            : "Campaign banned successfully";
        return sendSuccess(res, HTTP_STATUS.OK.withMessage(message), {
          campaign,
        });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  /**
   * Admin review of a pending campaign completion (approve or reject).
   */
  adminReviewCampaignCompletion = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    body("decision")
      .isIn(["approve", "reject"])
      .withMessage('decision must be "approve" or "reject"'),
    body("rejectReason").custom((value, { req }) => {
      const decision = req.body?.decision;
      const isReject = decision === "reject";
      if (value === undefined || value === null) {
        if (isReject) {
          throw new Error(
            "reject_reason is required when rejecting completion",
          );
        }
        return true;
      }
      if (typeof value !== "string") {
        throw new Error("reject_reason must be a string or null");
      }
      const trimmed = value.trim();
      if (isReject && !trimmed) {
        throw new Error(
          "reject_reason is required when rejecting completion",
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

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const role = req.user?.role?.toLowerCase();
        if (role !== "admin") {
          return sendError(
            res,
            HTTP_STATUS.FORBIDDEN.withMessage(
              "Only admin can review campaign completion",
            ),
          );
        }

        const { decision, rejectReason } =
          req.body as AdminCompletionReviewBody;
        const trimmedReason =
          typeof rejectReason === "string" ? rejectReason.trim() : undefined;

        const campaign = await campaignService.adminReviewCampaignCompletion(
          req.params.id,
          userId,
          decision,
          trimmedReason,
          userId,
        );

        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage(
            decision === "approve"
              ? "Campaign marked as done successfully"
              : "Completion request rejected; campaign returned to active",
          ),
          { campaign },
        );
      } catch (error) {
        console.error("Admin review campaign completion error:", error);
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            return sendError(
              res,
              HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
            );
          }
          if (
            error.message.includes("must await admin completion") ||
            error.message.includes("Some tasks is not completed") ||
            error.message.includes("Reject only applies")
          ) {
            return sendError(res, HTTP_STATUS.BAD_REQUEST.withMessage(error.message));
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * List campaigns with more than one submission awaiting approve/reject (admin only).
   */
  getCampaignsAwaitingMultiSubmissionReview = [
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
    query("sortBy").optional().isIn(["createdAt", "updatedAt", "title"]),
    query("sortOrder").optional().isIn(["asc", "desc"]),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const role = req.user?.role?.toLowerCase();
        if (role !== "admin") {
          return sendError(
            res,
            HTTP_STATUS.FORBIDDEN.withMessage(
              "Only admin can access this list",
            ),
          );
        }

        const q: CampaignMultiSubmissionReviewListQuery = {
          page: req.query.page
            ? parseInt(String(req.query.page), 10)
            : undefined,
          limit: req.query.limit
            ? parseInt(String(req.query.limit), 10)
            : undefined,
          sortBy: req.query
            .sortBy as CampaignMultiSubmissionReviewListQuery["sortBy"],
          sortOrder: req.query
            .sortOrder as CampaignMultiSubmissionReviewListQuery["sortOrder"],
        };

        const result =
          await campaignService.getCampaignsAwaitingMultiSubmissionReview(
            q,
            userId,
          );
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Admin multi-submission review list error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Manager: submit campaign for final admin completion approval (in review → awaiting admin).
   */
  markCampaignDone = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const campaign =
          await campaignService.submitCampaignCompletionForAdminApproval(
            req.params.id,
            userId,
          );

        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Campaign submitted for admin approval"),
          { campaign },
        );
      } catch (error) {
        console.error("Mark campaign done error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            return sendError(
              res,
              HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
            );
          }
          if (
            error.message.includes("must be in review") ||
            error.message.includes("must await admin completion") ||
            error.message.includes("not awaiting initial admin verification") ||
            error.message.includes("Only campaign managers")
          ) {
            return sendError(
              res,
              HTTP_STATUS.BAD_REQUEST.withMessage(error.message),
            );
          }
          if (error.message.includes("Some tasks is not completed")) {
            return sendError(
              res,
              HTTP_STATUS.BAD_REQUEST.withMessage(error.message),
            );
          }
          if (error.message.includes("difficulty missing")) {
            return sendError(
              res,
              HTTP_STATUS.BAD_REQUEST.withMessage(error.message),
            );
          }
          if (error.message.includes("Reward service enqueue failed")) {
            return sendError(
              res,
              HTTP_STATUS.BAD_GATEWAY.withMessage(error.message),
            );
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  updateCampaign = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    body("title").optional().trim(),
    body("banner")
      .optional({ nullable: true })
      .isString()
      .isLength({ max: 2048 })
      .withMessage("banner must be at most 2048 characters")
      .trim(),
    body("description").optional().trim(),
    body("status")
      .not()
      .exists()
      .withMessage(
        "status cannot be set here; use submit, review or mark-done",
      ),
    body("difficulty")
      .optional()
      .isInt({ min: CAMPAIGN_DIFFICULTY_MIN, max: CAMPAIGN_DIFFICULTY_MAX })
      .withMessage(
        `difficulty must be between ${CAMPAIGN_DIFFICULTY_MIN} and ${CAMPAIGN_DIFFICULTY_MAX}`,
      ),
    body("managerIds")
      .optional()
      .isArray()
      .withMessage("managerIds must be an array"),
    body("managerIds.*")
      .optional()
      .isUUID()
      .withMessage("Each managerId must be a valid UUID"),
    ...campaignDetailValidators(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const campaign = await campaignService.updateCampaign(
          req.params.id,
          userId,
          req.body,
        );

        sendSuccess(res, HTTP_STATUS.OK, { campaign });
      } catch (error) {
        console.error("Update campaign error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            return sendError(
              res,
              HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
            );
          }
          if (error.message.includes("reportIds")) {
            return sendError(
              res,
              HTTP_STATUS.BAD_REQUEST.withMessage(error.message),
            );
          }
          if (
            error.message.includes("REWARD_SERVICE_URL") ||
            error.message.includes("INTERNAL_REWARD_API_KEY")
          ) {
            return sendError(
              res,
              HTTP_STATUS.INTERNAL_SERVER_ERROR.withMessage(error.message),
            );
          }
        }

        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  deleteCampaign = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        await campaignService.deleteCampaign(req.params.id, userId);

        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Campaign deleted successfully"),
        );
      } catch (error) {
        console.error("Delete campaign error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            return sendError(
              res,
              HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
            );
          }
        }

        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  // =====================
  // Shift registrations (spec 3.1)
  // =====================

  /** GET /campaigns/:id/registration-options — what the "pick shifts" popup shows. */
  getRegistrationOptions = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      }
      try {
        const userId = req.user?.userId;
        if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        const options = await campaignRegistrationService.getOptions(req.params.id, userId);
        sendSuccess(res, HTTP_STATUS.OK, options);
      } catch (error) {
        console.error("Get registration options error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * PUT /campaigns/:id/registrations/me — replaces the caller's shifts; [] leaves the campaign.
   * Body: { shiftIds: string[], acceptConditions?: boolean }.
   */
  updateMyRegistrations = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    body("shiftIds").isArray({ max: 100 }).withMessage("shiftIds must be an array"),
    body("shiftIds.*").isUUID().withMessage("Each shift ID must be a valid UUID"),
    body("acceptConditions").optional().isBoolean().toBoolean(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      }
      try {
        const userId = req.user?.userId;
        if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        const result = await campaignRegistrationService.setMyShifts(req.params.id, userId, {
          shiftIds: req.body.shiftIds,
          acceptConditions: req.body.acceptConditions,
        });
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Update my registrations error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /** GET /campaigns/:id/registrations — each shift with who registered (managers, registered volunteers, admins). */
  getCampaignRegistrations = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      }
      try {
        const userId = req.user?.userId;
        if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        const [shifts, nextInviteAt] = await Promise.all([
          campaignRegistrationService.listByShift(req.params.id, {
            userId,
            role: req.user?.role,
          }),
          campaignRegistrationService.getNextInviteAt(req.params.id),
        ]);
        sendSuccess(res, HTTP_STATUS.OK, { shifts, nextInviteAt });
      } catch (error) {
        console.error("Get campaign registrations error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /** POST /campaigns/:id/invite-nearby — managers invite residents around the meeting points. */
  inviteNearby = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      }
      try {
        const userId = req.user?.userId;
        if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        const result = await campaignRegistrationService.inviteNearby(req.params.id, userId);
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Invite nearby residents error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /** POST /campaigns/:id/shifts/:shiftId/close — managers turn a shift off before it starts. */
  closeShift = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    param("shiftId").isUUID().withMessage("Shift ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      }
      try {
        const userId = req.user?.userId;
        if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        const result = await campaignRegistrationService.closeShift(
          req.params.id,
          req.params.shiftId,
          userId,
        );
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Close shift error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /** PUT /campaigns/:id/shifts/:shiftId/leader — choose who leads a shift (team only). */
  setShiftLeader = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    param("shiftId").isUUID().withMessage("Shift ID must be a valid UUID"),
    body("leaderUserId").isUUID().withMessage("leaderUserId must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      }
      try {
        const userId = req.user?.userId;
        if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        const result = await campaignManagerService.setShiftLeader(
          req.params.id,
          req.params.shiftId,
          req.body.leaderUserId,
          userId,
        );
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Set shift leader error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * GET /campaigns/volunteers/approved — people registered for at least one shift.
   * Query: campaignId (required), volunteerId?, page, limit, sortOrder.
   */
  getApprovedVolunteers = [
    query("campaignId")
      .notEmpty()
      .withMessage("Campaign ID is required")
      .isUUID()
      .withMessage("Campaign ID must be a valid UUID"),
    query("volunteerId").optional().isUUID(),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
    query("sortBy").optional().isIn(["createdAt", "updatedAt"]),
    query("sortOrder").optional().isIn(["asc", "desc"]),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      }
      try {
        const userId = req.user?.userId;
        if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        const result = await campaignRegistrationService.listVolunteers(
          String(req.query.campaignId).trim(),
          { userId, role: req.user?.role },
          {
            volunteerId: req.query.volunteerId ? String(req.query.volunteerId).trim() : undefined,
            page: req.query.page ? parseInt(String(req.query.page), 10) : undefined,
            limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
            sortOrder: req.query.sortOrder as "asc" | "desc" | undefined,
          },
        );
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Get registered volunteers error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  // =====================
  // Campaign managers
  // =====================

  addManagers = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    body("userIds")
      .isArray({ min: 1 })
      .withMessage("userIds must be a non-empty array"),
    body("userIds.*").isUUID().withMessage("Each userId must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const assignedBy = req.user?.userId;
        if (!assignedBy) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const managers = await campaignManagerService.addManagers(
          req.params.id,
          req.body,
          assignedBy,
        );
        sendSuccess(res, HTTP_STATUS.CREATED, { managers });
      } catch (error) {
        console.error("Add campaign managers error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  removeManager = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    body("userId").isUUID().withMessage("userId must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const removedBy = req.user?.userId;
        if (!removedBy) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        await campaignManagerService.removeManager(
          req.params.id,
          req.body.userId,
          removedBy,
        );
        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Manager removed successfully"),
        );
      } catch (error) {
        console.error("Remove campaign manager error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  getCampaignManagers = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    query("userId").optional().isUUID(),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
    query("sortBy").optional().isIn(["assignedAt", "userId", "createdAt"]),
    query("sortOrder").optional().isIn(["asc", "desc"]),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const q: CampaignManagersListQuery = {
          userId: req.query.userId
            ? String(req.query.userId).trim()
            : undefined,
          page: req.query.page
            ? parseInt(String(req.query.page), 10)
            : undefined,
          limit: req.query.limit
            ? parseInt(String(req.query.limit), 10)
            : undefined,
          sortBy: req.query.sortBy as CampaignManagersListQuery["sortBy"],
          sortOrder: req.query
            .sortOrder as CampaignManagersListQuery["sortOrder"],
        };

        const result = await campaignManagerService.listManagers(
          req.params.id,
          q,
        );
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Get campaign managers error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  // =====================
  // Campaign tasks
  // =====================

  createTask = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    body("title").notEmpty().withMessage("Title is required").trim(),
    body("description").optional().trim(),
    body("priority")
      .optional()
      .isInt({ min: 1, max: 3 })
      .withMessage("priority must be 1 (HIGH), 2 (MEDIUM), or 3 (LOW)"),
    body("scheduledDate")
      .optional()
      .isISO8601()
      .withMessage("Invalid date format"),
    body("scheduledTime")
      .optional()
      .isString()
      .withMessage("scheduledTime must be a string")
      .trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const task = await campaignTaskService.createTask(userId, {
          campaignId: req.params.id,
          title: req.body.title,
          description: req.body.description,
          priority:
            req.body.priority !== undefined
              ? parseInt(String(req.body.priority), 10)
              : undefined,
          scheduledDate: req.body.scheduledDate,
          scheduledTime: req.body.scheduledTime,
        });
        sendSuccess(res, HTTP_STATUS.CREATED, { task });
      } catch (error) {
        console.error("Create campaign task error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  getCampaignTasks = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const tasks = await campaignTaskService.getCampaignTasks(req.params.id);
        sendSuccess(res, HTTP_STATUS.OK, { tasks });
      } catch (error) {
        console.error("Get campaign tasks error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  getTaskById = [
    param("taskId").isUUID().withMessage("Task ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const task = await campaignTaskService.getTaskDetail(req.params.taskId);
        if (!task) {
          return sendError(res, HTTP_STATUS.NOT_FOUND);
        }
        sendSuccess(res, HTTP_STATUS.OK, { task });
      } catch (error) {
        console.error("Get campaign task error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  updateTask = [
    param("taskId").isUUID().withMessage("Task ID must be a valid UUID"),
    body("title").optional().trim(),
    body("description").optional().trim(),
    body("status").optional().isInt(),
    body("priority")
      .optional()
      .isInt({ min: 1, max: 3 })
      .withMessage("priority must be 1 (HIGH), 2 (MEDIUM), or 3 (LOW)"),
    body("result")
      .optional()
      .isObject()
      .withMessage("result must be an object"),
    body("result.description").optional().isString(),
    body("result.file").optional().isArray(),
    body("result.file.*").optional().isString().trim(),
    body("result.fileKinds").optional().isArray(),
    body("result.fileKinds.*")
      .optional()
      .isIn(["image", "video", "file"])
      .withMessage("result.fileKinds values must be image, video, or file"),
    body("scheduledDate")
      .optional()
      .isISO8601()
      .withMessage("Invalid date format"),
    body("scheduledTime")
      .optional()
      .isString()
      .withMessage("scheduledTime must be a string")
      .trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const b = req.body as Record<string, unknown>;
        const updateData: {
          title?: string;
          description?: string;
          status?: number;
          scheduledDate?: string;
          scheduledTime?: string;
          priority?: number;
          result?: {
            description?: string;
            file?: string[];
            fileKinds?: Array<"image" | "video" | "file">;
          };
        } = {};
        if (b.title !== undefined) updateData.title = b.title as string;
        if (b.description !== undefined) {
          updateData.description = b.description as string;
        }
        if (b.status !== undefined) {
          updateData.status = parseInt(String(b.status), 10);
        }
        if (b.priority !== undefined) {
          updateData.priority = parseInt(String(b.priority), 10);
        }
        if (b.scheduledDate !== undefined) {
          updateData.scheduledDate = b.scheduledDate as string;
        }
        if (b.scheduledTime !== undefined) {
          updateData.scheduledTime = b.scheduledTime as string;
        }
        if (b.result !== undefined) {
          const result = b.result as Record<string, unknown>;
          updateData.result = {};
          if (result.description !== undefined) {
            updateData.result.description = result.description as string;
          }
          if (result.file !== undefined) {
            updateData.result.file = result.file as string[];
          }
          if (result.fileKinds !== undefined) {
            updateData.result.fileKinds = result.fileKinds as Array<
              "image" | "video" | "file"
            >;
          }
        }

        const task = await campaignTaskService.updateTask(
          req.params.taskId,
          userId,
          updateData,
        );
        sendSuccess(res, HTTP_STATUS.OK, { task });
      } catch (error) {
        console.error("Update campaign task error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  deleteTask = [
    param("taskId").isUUID().withMessage("Task ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        await campaignTaskService.deleteTask(req.params.taskId, userId);
        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Task deleted successfully"),
        );
      } catch (error) {
        console.error("Delete campaign task error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  assignTask = [
    param("taskId").isUUID().withMessage("Task ID must be a valid UUID"),
    body("volunteerId")
      .isUUID()
      .withMessage("Volunteer ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const assignment = await campaignTaskService.assignTask(
          req.params.taskId,
          req.body.volunteerId as string,
          userId,
        );
        sendSuccess(res, HTTP_STATUS.CREATED, { assignment });
      } catch (error) {
        console.error("Assign campaign task error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  unassignTask = [
    param("taskId").isUUID().withMessage("Task ID must be a valid UUID"),
    body("volunteerId")
      .isUUID()
      .withMessage("Volunteer ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        await campaignTaskService.unassignTask(
          req.params.taskId,
          req.body.volunteerId as string,
          userId,
        );
        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Volunteer unassigned successfully"),
        );
      } catch (error) {
        console.error("Unassign campaign task error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  getMyAssignedTasks = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      const tasks = await campaignTaskService.getMyAssignedTasks(userId);
      sendSuccess(res, HTTP_STATUS.OK, { tasks });
    } catch (error) {
      console.error("Get my assigned tasks error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

  updateTaskStatus = [
    param("taskId").isUUID().withMessage("Task ID must be a valid UUID"),
    body("status").isInt().withMessage("Invalid status"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const task = await campaignTaskService.updateTaskStatusByVolunteer(
          req.params.taskId,
          userId,
          parseInt(req.body.status, 10),
        );
        sendSuccess(res, HTTP_STATUS.OK, { task });
      } catch (error) {
        console.error("Update campaign task status error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  issueCampaignAttendanceQr = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const { token, expiresAt } =
          await campaignAttendanceService.issueAttendanceQr(
            req.params.id,
            userId,
          );

        sendSuccess(res, HTTP_STATUS.OK, {
          token,
          expiresAt,
        });
      } catch (error) {
        console.error("Issue campaign attendance QR error:", error);
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  checkInCampaignAttendance = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    body("token").notEmpty().withMessage("token is required").isString(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const rawToken = String(req.body.token).trim();
        const result = await campaignAttendanceService.checkInWithQrToken(
          req.params.id,
          rawToken,
          userId,
        );

        sendSuccess(res, HTTP_STATUS.OK, {
          checkedInAt: result.checkedInAt,
          alreadyCheckedIn: result.alreadyCheckedIn,
        });
      } catch (error) {
        console.error("Campaign attendance check-in error:", error);
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];
}

export const campaignController = new CampaignController();
