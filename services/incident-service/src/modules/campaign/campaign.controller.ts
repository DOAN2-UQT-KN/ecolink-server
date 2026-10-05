import { Request, Response } from "express";
import { body, param, query, validationResult, type ValidationChain } from "express-validator";
import {
  HTTP_STATUS,
  HttpError,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { campaignService } from "./campaign.service";
import { campaignManagerService } from "./campaign_manager/campaign_manager.service";
import { campaignRegistrationService } from "./campaign_registration/campaign_registration.service";
import { shiftAttendanceService } from "./campaign_attendance/shift-attendance.service";
import { shiftResultService } from "./campaign_shift_result/shift-result.service";
import { campaignCompletionService } from "./campaign_completion/completion.service";
import {
  campaignVerificationService,
  type VoteValueInput,
} from "./campaign_verification/verification.service";
import { GlobalStatus } from "../../constants/status.enum";
import {
  CAMPAIGN_COMPLETION_UNHANDLED_REASON_MAX,
  CAMPAIGN_DIFFICULTY_MAX,
  CAMPAIGN_DIFFICULTY_MIN,
  CAMPAIGN_DAY_MAX,
  CAMPAIGN_MEETING_POINT_MAX,
  CAMPAIGN_REVIEW_REASON_MAX_LENGTH,
  MEETING_POINT_VOTE_NOTE_MAX,
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
  MarkCampaignDoneBody,
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

  /** POST /campaigns/:id/cancel — the creator or an owner cancels the campaign (spec 3.6). */
  cancelCampaign = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    body("reason")
      .isString()
      .trim()
      .isLength({ min: 1, max: CAMPAIGN_REVIEW_REASON_MAX_LENGTH })
      .withMessage(`reason is required, at most ${CAMPAIGN_REVIEW_REASON_MAX_LENGTH} characters`),
    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      }
      const userId = req.user?.userId;
      if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      try {
        const campaign = await campaignService.cancelCampaign(req.params.id, userId, req.body.reason);
        sendSuccess(res, HTTP_STATUS.OK, { campaign });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) return;
        console.error("Cancel campaign error:", error);
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
   * Admin decision on a campaign marked done: cancel (`rejectReason`) at any time, approve
   * (optional `difficulty`) only once result verification handed it over (409
   * CAMPAIGN_COMPLETION_NOT_AWAITING_ADMIN otherwise). Rejecting is decided per trash point now.
   */
  adminReviewCampaignCompletion = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    body("decision")
      .isIn(["approve", "cancel"])
      .withMessage('decision must be "approve" or "cancel"'),
    body("rejectReason").custom((value, { req }) => {
      const needsReason = req.body?.decision === "cancel";
      if (value === undefined || value === null) {
        if (needsReason) throw new Error("rejectReason is required to cancel");
        return true;
      }
      if (typeof value !== "string") {
        throw new Error("rejectReason must be a string or null");
      }
      const trimmed = value.trim();
      if (needsReason && !trimmed) {
        throw new Error("rejectReason is required to cancel");
      }
      if (trimmed.length > 5000) {
        throw new Error("rejectReason too long (max 5000 characters)");
      }
      return true;
    }),
    body("difficulty").optional({ values: "null" }).isInt().withMessage("difficulty must be a whole number"),

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

        const { decision, rejectReason, difficulty } =
          req.body as AdminCompletionReviewBody;
        const campaign = await campaignService.adminReviewCampaignCompletion(
          req.params.id,
          userId,
          {
            decision,
            rejectReason: typeof rejectReason === "string" ? rejectReason.trim() : undefined,
            difficulty: difficulty == null ? null : Number(difficulty),
          },
          userId,
        );

        const messages = {
          approve: "Campaign marked as done successfully",
          cancel: "Campaign cancelled",
        } as const;
        sendSuccess(res, HTTP_STATUS.OK.withMessage(messages[decision]), { campaign });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        console.error("Admin review campaign completion error:", error);
        if (error instanceof Error && error.message.includes("not found")) {
          return sendError(res, HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"));
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
   * Manager: mark the campaign done; result verification opens the voting rounds.
   */
  markCampaignDone = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    body("unhandled").optional().isArray({ max: 500 }),
    body("unhandled.*.reportId").isUUID().withMessage("reportId must be a valid UUID"),
    body("unhandled.*.reason")
      .isString()
      .trim()
      .isLength({ min: 1, max: CAMPAIGN_COMPLETION_UNHANDLED_REASON_MAX })
      .withMessage(`reason is required (1–${CAMPAIGN_COMPLETION_UNHANDLED_REASON_MAX} characters)`),

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
          await campaignService.submitCampaignCompletion(
            req.params.id,
            userId,
            undefined,
            ((req.body as MarkCampaignDoneBody)?.unhandled ?? []).map((u) => ({
              reportId: String(u.reportId),
              reason: String(u.reason ?? ""),
            })),
          );

        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Campaign marked done; result verification started"),
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

  /** Legacy campaign-level "clean / not clean" answers: gone, residents vote per trash point. */
  completionVerificationGone = (_req: Request, res: Response): void => {
    sendError(res, HTTP_STATUS.CAMPAIGN_COMPLETION_VERIFICATION_GONE);
  };

  /** Legacy per-campaign attendance (before spec 4.1): gone, attendance is per shift now. */
  legacyAttendanceGone = (_req: Request, res: Response): void => {
    sendError(res, HTTP_STATUS.ATTENDANCE_LEGACY_GONE);
  };

  // =====================
  // Attendance per shift (spec 4.1)
  // =====================

  private shiftAttendanceAction(
    label: string,
    run: (req: Request, userId: string) => Promise<unknown>,
    extra: ValidationChain[] = [],
  ) {
    return [
      param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
      param("shiftId").optional().isUUID().withMessage("Shift ID must be a valid UUID"),
      ...extra,
      async (req: Request, res: Response): Promise<void> => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
        }
        const userId = req.user?.userId;
        if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        try {
          sendSuccess(res, HTTP_STATUS.OK, await run(req, userId));
        } catch (error) {
          if (sendHttpErrorResponse(res, error)) return;
          console.error(`${label} error:`, error);
          sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      },
    ];
  }

  /** POST /campaigns/:id/shifts/:shiftId/attendance/session — open (or get) the QR session. */
  openAttendanceSession = this.shiftAttendanceAction("Open attendance session", (req, userId) =>
    shiftAttendanceService
      .openSession(req.params.id, req.params.shiftId, userId)
      .then((session) => ({ session })),
  );

  /** GET /campaigns/:id/shifts/:shiftId/attendance/qr — the current dynamic code. */
  getAttendanceQr = this.shiftAttendanceAction("Get attendance QR", (req, userId) =>
    shiftAttendanceService.issueQr(req.params.id, req.params.shiftId, userId),
  );

  /** POST /campaigns/:id/shifts/:shiftId/attendance/close — end attendance, check everyone out. */
  closeAttendance = this.shiftAttendanceAction("Close attendance", (req, userId) =>
    shiftAttendanceService.closeSession(req.params.id, req.params.shiftId, userId),
  );

  /** POST /campaigns/:id/shifts/:shiftId/attendance/manual — record someone by hand, with a reason. */
  addManualAttendance = this.shiftAttendanceAction(
    "Add manual attendance",
    (req, userId) =>
      shiftAttendanceService.addManual(req.params.id, req.params.shiftId, userId, {
        userId: req.body.userId,
        reason: req.body.reason,
        checkInAt: req.body.checkInAt ? new Date(req.body.checkInAt) : undefined,
      }),
    [
      body("userId").isUUID().withMessage("userId must be a valid UUID"),
      body("reason").isString().trim().isLength({ min: 1, max: 500 }).withMessage("reason is required"),
      body("checkInAt").optional({ values: "null" }).isISO8601(),
    ],
  );

  /** POST /campaigns/:id/shifts/:shiftId/attendance/:userId/exclude — out of the points, with a reason. */
  excludeAttendance = this.shiftAttendanceAction(
    "Exclude attendance",
    (req, userId) =>
      shiftAttendanceService.setExcluded(req.params.id, req.params.shiftId, req.params.userId, userId, {
        reason: req.body.reason,
      }),
    [
      param("userId").isUUID().withMessage("userId must be a valid UUID"),
      body("reason").isString().trim().isLength({ min: 1, max: 500 }).withMessage("reason is required"),
    ],
  );

  /** POST /campaigns/:id/shifts/:shiftId/attendance/:userId/restore — back into the points. */
  restoreAttendance = this.shiftAttendanceAction(
    "Restore attendance",
    (req, userId) =>
      shiftAttendanceService.setExcluded(req.params.id, req.params.shiftId, req.params.userId, userId, null),
    [param("userId").isUUID().withMessage("userId must be a valid UUID")],
  );

  /** GET /campaigns/:id/shifts/:shiftId/attendance — who is present (leader, managers, admins). */
  getShiftAttendance = this.shiftAttendanceAction("Get shift attendance", (req, userId) =>
    shiftAttendanceService.listForShift(req.params.id, req.params.shiftId, {
      userId,
      role: req.user?.role,
    }),
  );

  /** POST /campaigns/:id/attendance/scan — check in or out with the shift's code and GPS. */
  scanAttendance = this.shiftAttendanceAction(
    "Scan attendance",
    (req, userId) =>
      shiftAttendanceService.scan(req.params.id, userId, {
        token: String(req.body.token).trim(),
        latitude: Number(req.body.latitude),
        longitude: Number(req.body.longitude),
        accuracy: Number(req.body.accuracy),
        scannedAt: req.body.scannedAt ? new Date(req.body.scannedAt) : undefined,
      }),
    [
      body("token").isString().notEmpty().withMessage("token is required"),
      body("latitude").isFloat({ min: -90, max: 90 }).withMessage("latitude is required"),
      body("longitude").isFloat({ min: -180, max: 180 }).withMessage("longitude is required"),
      body("accuracy").isFloat({ min: 0 }).withMessage("accuracy is required"),
      body("scannedAt").optional({ values: "null" }).isISO8601(),
    ],
  );

  // =====================
  // Shift results and status (spec 4.2)
  // =====================

  /** GET /campaigns/:id/shifts/:shiftId/result — status for anyone; the result on a public campaign; the pool for those allowed. */
  getShiftResult = this.shiftAttendanceAction("Get shift result", (req, userId) =>
    shiftResultService.get(req.params.id, req.params.shiftId, { userId, role: req.user?.role }),
  );

  /** PUT /campaigns/:id/shifts/:shiftId/result — submit or replace the result (leader or managers). */
  saveShiftResult = this.shiftAttendanceAction(
    "Save shift result",
    (req, userId) =>
      shiftResultService.save(req.params.id, req.params.shiftId, userId, {
        description: String(req.body.description ?? ""),
        wasteBags: req.body.wasteBags == null ? null : Number(req.body.wasteBags),
        wasteKg: req.body.wasteKg == null ? null : Number(req.body.wasteKg),
        reports: (req.body.reports ?? []).map((r: Record<string, unknown>) => ({
          reportId: String(r.reportId),
          status: String(r.status),
          beforeUrls: Array.isArray(r.beforeUrls) ? r.beforeUrls.map(String) : [],
          afterUrls: Array.isArray(r.afterUrls) ? r.afterUrls.map(String) : [],
        })),
        mediaIds: (req.body.mediaIds ?? []).map(String),
      }),
    [
      body("description").isString().trim().isLength({ min: 1, max: 5000 }).withMessage("description is required"),
      body("wasteBags").optional({ values: "null" }).isInt({ min: 0 }),
      body("wasteKg").optional({ values: "null" }).isFloat({ min: 0 }),
      body("reports").optional().isArray({ max: 200 }),
      body("reports.*.reportId").isUUID().withMessage("reportId must be a valid UUID"),
      body("reports.*.status").isIn(["cleaned", "partial"]).withMessage("status is cleaned or partial"),
      body("reports.*.beforeUrls").isArray(),
      body("reports.*.afterUrls").isArray(),
      body("mediaIds").optional().isArray({ max: 500 }),
      body("mediaIds.*").isUUID().withMessage("mediaIds must be UUIDs"),
    ],
  );

  /** POST /campaigns/:id/shifts/:shiftId/end — end a running shift early, once it has a result. */
  endShiftEarly = this.shiftAttendanceAction("End shift early", (req, userId) =>
    shiftResultService.endEarly(req.params.id, req.params.shiftId, userId),
  );

  /** POST /campaigns/:id/shifts/:shiftId/media — add a photo or video to the shift's pool. */
  addShiftMedia = this.shiftAttendanceAction(
    "Add shift media",
    (req, userId) =>
      shiftResultService
        .addMedia(req.params.id, req.params.shiftId, userId, {
          url: String(req.body.url),
          kind: String(req.body.kind),
        })
        .then((media) => ({ media })),
    [
      body("url").isString().trim().isLength({ min: 1, max: 2000 }).withMessage("url is required"),
      body("kind").isIn(["image", "video"]).withMessage("kind is image or video"),
    ],
  );

  /** DELETE /campaigns/:id/shifts/:shiftId/media/:mediaId — remove a photo from the pool. */
  removeShiftMedia = this.shiftAttendanceAction(
    "Remove shift media",
    (req, userId) =>
      shiftResultService.removeMedia(req.params.id, req.params.shiftId, req.params.mediaId, userId),
    [param("mediaId").isUUID().withMessage("mediaId must be a valid UUID")],
  );

  /**
   * POST /campaigns/:id/shifts/:shiftId/result-photos — multipart `file` (original photo, ≤ 15 MB),
   * `reportId`, `side` (before|after), `pinLat`, `pinLng`; graded at once (Layer 1).
   */
  uploadResultPhoto = this.shiftAttendanceAction("Upload result photo", (req, userId) => {
    const field = (camel: string, snake: string) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return b[camel] ?? b[snake];
    };
    const file = (req as Request & { file?: { buffer: Buffer; mimetype: string; size: number } }).file;
    return shiftResultService.uploadPhoto(req.params.id, req.params.shiftId, userId, {
      file: file ? { buffer: file.buffer, mimetype: file.mimetype, size: file.size } : null,
      reportId: String(field("reportId", "report_id") ?? ""),
      side: String(field("side", "side") ?? ""),
      pinLat: Number(field("pinLat", "pin_lat")),
      pinLng: Number(field("pinLng", "pin_lng")),
    });
  });

  /** GET /campaigns/:id/verification — every meeting point under result verification. */
  getVerification = this.shiftAttendanceAction("Get result verification", (req, userId) =>
    campaignVerificationService.getView(req.params.id, { userId, role: req.user?.role }),
  );

  /** PUT /campaigns/:id/verification/:meetingPointId/vote — a resident's vote on a meeting point. */
  voteMeetingPoint = this.shiftAttendanceAction(
    "Vote on meeting point",
    (req, userId) => {
      const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
      return campaignVerificationService.vote(
        req.params.id,
        req.params.meetingPointId,
        { userId, role: req.user?.role },
        {
          value: req.body.value as VoteValueInput,
          note: typeof req.body.note === "string" ? req.body.note : null,
          photoUrl: typeof req.body.photoUrl === "string" ? req.body.photoUrl : null,
          reportIds: Array.isArray(req.body.reportIds) ? req.body.reportIds.map(String) : null,
          latitude: num(req.body.latitude),
          longitude: num(req.body.longitude),
          accuracy: num(req.body.accuracy),
        },
      );
    },
    [
      param("meetingPointId").isUUID().withMessage("meetingPointId must be a valid UUID"),
      body("value").isIn(["up", "down"]).withMessage('value is "up" (clean) or "down" (not clean)'),
      body("note").optional({ values: "null" }).isString().isLength({ max: MEETING_POINT_VOTE_NOTE_MAX }),
      body("photoUrl").optional({ values: "null" }).isString().isLength({ max: 2000 }),
      body("reportIds").optional({ values: "null" }).isArray({ max: 200 }).withMessage("report_ids is a list of trash report ids"),
      body("latitude").optional({ values: "null" }).isFloat({ min: -90, max: 90 }),
      body("longitude").optional({ values: "null" }).isFloat({ min: -180, max: 180 }),
      body("accuracy").optional({ values: "null" }).isFloat({ min: 0 }),
    ],
  );

  /** DELETE /campaigns/:id/verification/:meetingPointId/vote — take one's vote back. */
  unvoteMeetingPoint = this.shiftAttendanceAction(
    "Remove meeting point vote",
    (req, userId) =>
      campaignVerificationService.unvote(req.params.id, req.params.meetingPointId, {
        userId,
        role: req.user?.role,
      }),
    [param("meetingPointId").isUUID().withMessage("meetingPointId must be a valid UUID")],
  );

  /** PUT /campaigns/:id/verification/:meetingPointId/decision — admin: verify or reject a flagged meeting point. */
  decideMeetingPoint = this.shiftAttendanceAction(
    "Decide meeting point",
    async (req, userId) => {
      if (!isPlatformAdmin(req.user?.role)) {
        throw new HttpError(HTTP_STATUS.FORBIDDEN.withMessage("Only admin can decide a flagged meeting point"));
      }
      return campaignVerificationService.decide(req.params.id, req.params.meetingPointId, userId, {
        decision: req.body.decision,
        reason: typeof req.body.reason === "string" ? req.body.reason : null,
        reportIds: Array.isArray(req.body.reportIds) ? req.body.reportIds.map(String) : null,
      });
    },
    [
      param("meetingPointId").isUUID().withMessage("meetingPointId must be a valid UUID"),
      body("decision").isIn(["verify", "reject"]).withMessage('decision is "verify" or "reject"'),
      body("reason").optional({ values: "null" }).isString().isLength({ max: 5000 }),
      body("reportIds").optional({ values: "null" }).isArray({ max: 200 }).withMessage("report_ids is a list of trash report ids"),
    ],
  );

  /** GET /campaigns/:id/completion-review — the submission, totals and residents' answers (spec 5.2). */
  getCompletionReview = this.shiftAttendanceAction("Get completion review", (req, userId) =>
    campaignCompletionService.getForReview(req.params.id, { userId, role: req.user?.role }),
  );

  /** GET /campaigns/:id/shift-overview — every shift's status and the totals (anyone on a public campaign). */
  getShiftOverview = this.shiftAttendanceAction("Get shift overview", (req, userId) =>
    shiftResultService.overview(req.params.id, { userId, role: req.user?.role }),
  );
}

export const campaignController = new CampaignController();
