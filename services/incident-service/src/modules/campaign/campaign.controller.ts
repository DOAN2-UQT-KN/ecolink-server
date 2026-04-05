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
import { campaignJoiningRequestService } from "./campaign_joining_request/campaign_joining_request.service";
import { JoinRequestStatus } from "../../constants/status.enum";
import type {
  CampaignListQuery,
  CampaignManagersListQuery,
  GetApprovedVolunteersQuery,
  GetJoinRequestsQuery,
  MyJoinRequestsQuery,
} from "./campaign.dto";
import { normalizeQueryUuidList } from "../../utils/query-uuid-list";

const CAMPAIGN_BATCH_QUERY_MAX_IDS = 100;

export class CampaignController {
  constructor() { }

  createCampaign = [
    body("title").notEmpty().withMessage("Title is required").trim(),
    body("description").optional().trim(),
    body("difficulty")
      .isInt({ min: 1 })
      .withMessage("difficulty must be a positive integer (reward-service tier)"),
    body("reportIds")
      .optional()
      .isArray()
      .withMessage("reportIds must be an array"),
    body("reportIds.*")
      .optional()
      .isUUID()
      .withMessage("Each reportId must be a valid UUID"),

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
        if (error instanceof Error) {
          if (error.message.includes("reportIds")) {
            return sendError(
              res,
              HTTP_STATUS.BAD_REQUEST.withMessage(error.message),
            );
          }
          if (error.message.includes("Invalid campaign difficulty")) {
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
    query("createdBy").optional().isUUID(),
    query("managerId").optional().isUUID(),
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
        const q: CampaignListQuery = {
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
          createdBy: req.query.createdBy
            ? String(req.query.createdBy).trim()
            : undefined,
          managerId: req.query.managerId
            ? String(req.query.managerId).trim()
            : undefined,
          sortBy: req.query.sortBy as CampaignListQuery["sortBy"],
          sortOrder: req.query.sortOrder as CampaignListQuery["sortOrder"],
        };

        const result = await campaignService.getCampaigns(q);
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Get campaigns error:", error);
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
        const campaign = await campaignService.getCampaignById(req.params.id);
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

  /**
   * Verify a campaign (admin only).
   */
  adminVerifyCampaign = [
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

        const campaign = await campaignService.adminVerifyCampaign(
          req.params.id,
        );
        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Campaign verified successfully"),
          { campaign },
        );
      } catch (error) {
        console.error("Admin verify campaign error:", error);
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

  updateCampaign = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    body("title").optional().trim(),
    body("description").optional().trim(),
    body("status").optional().isInt().withMessage("Status must be an integer"),
    body("difficulty")
      .optional()
      .isInt({ min: 1 })
      .withMessage("difficulty must be a positive integer (reward-service tier)"),
    body("reportIds")
      .optional()
      .isArray()
      .withMessage("reportIds must be an array"),
    body("reportIds.*")
      .optional()
      .isUUID()
      .withMessage("Each reportId must be a valid UUID"),
    body("managerIds")
      .optional()
      .isArray()
      .withMessage("managerIds must be an array"),
    body("managerIds.*")
      .optional()
      .isUUID()
      .withMessage("Each managerId must be a valid UUID"),

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
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            return sendError(
              res,
              HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
            );
          }
          if (
            error.message.includes("Only campaign manager") ||
            error.message.includes("Forbidden")
          ) {
            return sendError(
              res,
              HTTP_STATUS.FORBIDDEN.withMessage(
                "Only campaign manager can modify campaign",
              ),
            );
          }
          if (error.message.includes("reportIds")) {
            return sendError(
              res,
              HTTP_STATUS.BAD_REQUEST.withMessage(error.message),
            );
          }
          if (error.message.includes("Invalid campaign difficulty")) {
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
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            return sendError(
              res,
              HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
            );
          }
          if (
            error.message.includes("Only campaign manager") ||
            error.message.includes("Forbidden")
          ) {
            return sendError(
              res,
              HTTP_STATUS.FORBIDDEN.withMessage(
                "Only campaign manager can modify campaign",
              ),
            );
          }
        }

        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  // =====================
  // Joining Request Operations
  // =====================

  /**
   * Create a join request for a campaign
   */
  createJoinRequest = [
    body("campaignId").notEmpty().withMessage("Campaign ID is required").trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const volunteerId = req.user?.userId;
        if (!volunteerId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const joinRequest =
          await campaignJoiningRequestService.createJoinRequest(
            req.body.campaignId,
            volunteerId,
          );
        sendSuccess(res, HTTP_STATUS.CREATED, { joinRequest });
      } catch (error) {
        console.error("Create campaign join request error:", error);
        if (error instanceof Error) {
          if (error.message.includes("Campaign not found")) {
            return sendError(
              res,
              HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
            );
          }
          if (error.message.includes("already exists")) {
            return sendError(
              res,
              HTTP_STATUS.CONFLICT.withMessage("Join request already exists"),
            );
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * GET /campaigns/volunteers/join-requests — list join requests for a campaign (managers only).
   * Query: campaignId (required), status?, volunteerId?, page, limit, sortBy, sortOrder.
   */
  getJoinRequests = [
    query("campaignId")
      .notEmpty()
      .withMessage("Campaign ID is required")
      .trim(),
    query("status").optional().isInt().withMessage("status must be an integer"),
    query("volunteerId")
      .optional()
      .isUUID()
      .withMessage("volunteerId must be a valid UUID"),
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

      try {
        const managerId = req.user?.userId;
        if (!managerId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const q: GetJoinRequestsQuery = {
          campaignId: String(req.query.campaignId).trim(),
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
          volunteerId: req.query.volunteerId
            ? String(req.query.volunteerId).trim()
            : undefined,
          sortBy: req.query.sortBy as GetJoinRequestsQuery["sortBy"],
          sortOrder: req.query.sortOrder as GetJoinRequestsQuery["sortOrder"],
        };

        const result =
          await campaignJoiningRequestService.getJoinRequestsByCampaignForManager(
            q.campaignId,
            managerId,
            q,
          );
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Get campaign join requests error:", error);
        if (error instanceof Error) {
          if (error.message.includes("Only campaign managers")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * GET /campaigns/volunteers/join-requests/my — my join requests with optional filters and pagination.
   */
  getMyJoinRequests = [
    query("campaignId").optional().isUUID(),
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

      try {
        const volunteerId = req.user?.userId;
        if (!volunteerId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const q: MyJoinRequestsQuery = {
          campaignId: req.query.campaignId
            ? String(req.query.campaignId).trim()
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
          sortBy: req.query.sortBy as MyJoinRequestsQuery["sortBy"],
          sortOrder: req.query.sortOrder as MyJoinRequestsQuery["sortOrder"],
        };

        const result =
          await campaignJoiningRequestService.getMyJoinRequests(
            volunteerId,
            q,
          );
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Get my join requests error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Approve or reject a join request (campaign managers only)
   */
  processJoinRequest = [
    body("requestId").notEmpty().withMessage("Request ID is required").trim(),
    body("approved").isBoolean().withMessage("Approved must be boolean"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const managerId = req.user?.userId;
        if (!managerId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const status = req.body.approved
          ? JoinRequestStatus._STATUS_APPROVED
          : JoinRequestStatus._STATUS_REJECTED;

        const joinRequest =
          await campaignJoiningRequestService.processJoinRequest(
            req.body.requestId,
            managerId,
            status,
          );
        sendSuccess(res, HTTP_STATUS.OK, { joinRequest });
      } catch (error) {
        console.error("Process join request error:", error);
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            return sendError(res, HTTP_STATUS.NOT_FOUND);
          }
          if (error.message.includes("Only campaign managers")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
          if (error.message.includes("already processed")) {
            return sendError(
              res,
              HTTP_STATUS.CONFLICT.withMessage("Join request already processed"),
            );
          }
          if (error.message.includes("capacity exceeded")) {
            return sendError(
              res,
              HTTP_STATUS.BAD_REQUEST.withMessage(error.message),
            );
          }
          if (
            error.message.includes("REWARD_SERVICE_URL") ||
            error.message.includes("INTERNAL_REWARD_API_KEY") ||
            error.message.includes("Invalid reward service")
          ) {
            return sendError(
              res,
              HTTP_STATUS.INTERNAL_SERVER_ERROR.withMessage(
                error.message,
              ),
            );
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Cancel a join request (volunteer only)
   */
  cancelJoinRequest = [
    body("requestId").notEmpty().withMessage("Request ID is required").trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const volunteerId = req.user?.userId;
        if (!volunteerId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        await campaignJoiningRequestService.cancelJoinRequest(
          req.body.requestId,
          volunteerId,
        );
        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Join request cancelled successfully"),
        );
      } catch (error) {
        console.error("Cancel join request error:", error);
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            return sendError(res, HTTP_STATUS.NOT_FOUND);
          }
          if (error.message.includes("Cannot cancel")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
          if (error.message.includes("only cancel pending")) {
            return sendError(
              res,
              HTTP_STATUS.CONFLICT.withMessage("Can only cancel pending requests"),
            );
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * GET /campaigns/volunteers/approved — approved volunteers for a campaign (managers only).
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
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const managerId = req.user?.userId;
        if (!managerId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const q: GetApprovedVolunteersQuery = {
          campaignId: String(req.query.campaignId).trim(),
          volunteerId: req.query.volunteerId
            ? String(req.query.volunteerId).trim()
            : undefined,
          page: req.query.page
            ? parseInt(String(req.query.page), 10)
            : undefined,
          limit: req.query.limit
            ? parseInt(String(req.query.limit), 10)
            : undefined,
          sortBy: req.query.sortBy as GetApprovedVolunteersQuery["sortBy"],
          sortOrder:
            req.query.sortOrder as GetApprovedVolunteersQuery["sortOrder"],
        };

        const result =
          await campaignJoiningRequestService.getApprovedVolunteersForManager(
            q.campaignId,
            managerId,
            q,
          );
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Get approved volunteers error:", error);
        if (error instanceof Error) {
          if (error.message.includes("Only campaign managers")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
        }
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
          sortOrder:
            req.query.sortOrder as CampaignManagersListQuery["sortOrder"],
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
    body("scheduledTime")
      .optional()
      .isISO8601()
      .withMessage("Invalid date format"),

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
    body("scheduledTime")
      .optional()
      .isISO8601()
      .withMessage("Invalid date format"),

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
          scheduledTime?: string;
        } = {};
        if (b.title !== undefined) updateData.title = b.title as string;
        if (b.description !== undefined) {
          updateData.description = b.description as string;
        }
        if (b.status !== undefined) {
          updateData.status = parseInt(String(b.status), 10);
        }
        if (b.scheduledTime !== undefined) {
          updateData.scheduledTime = b.scheduledTime as string;
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
}

export const campaignController = new CampaignController();

