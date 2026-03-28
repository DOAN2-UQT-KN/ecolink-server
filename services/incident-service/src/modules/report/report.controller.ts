import { Request, Response } from "express";
import { body, param, query, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { reportService } from "./report.service";
import { campaignManagerService } from "../campaign/campaign_manager/campaign_manager.service";
import { campaignTaskService } from "../campaign/campaign_task/campaign_task.service";
import { ReportSearchQuery } from "./report.dto";

export class ReportController {
  constructor() { }

  /**
   * Create a new report
   */
  createReport = [
    body("title").notEmpty().withMessage("Title is required").trim(),
    body("description").optional().trim(),
    body("wasteType").optional().trim(),
    body("severityLevel")
      .optional()
      .isInt({ min: 1, max: 5 })
      .withMessage("Severity level must be between 1 and 5"),
    body("latitude")
      .exists({ values: "null" })
      .withMessage("Latitude is required")
      .bail()
      .isFloat({ min: -90, max: 90 })
      .withMessage("Invalid latitude"),
    body("longitude")
      .exists({ values: "null" })
      .withMessage("Longitude is required")
      .bail()
      .isFloat({ min: -180, max: 180 })
      .withMessage("Invalid longitude"),
    body("imageUrls")
      .isArray({ min: 1 })
      .withMessage("imageUrls must be a non-empty array"),
    body("imageUrls.*")
      .isString()
      .withMessage("Each image_url must be a string")
      .bail()
      .trim()
      .notEmpty()
      .withMessage("Each image_url must not be empty"),

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

        const report = await reportService.createReport(userId, req.body);
        sendSuccess(res, HTTP_STATUS.CREATED, { report });
      } catch (error) {
        console.error("Create report error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Get report by ID
   */
  getReportById = async (req: Request, res: Response): Promise<void> => {
    try {
      const report = await reportService.getReportById(req.params.id);

      if (!report) {
        return sendError(res, HTTP_STATUS.REPORT_NOT_FOUND);
      }

      sendSuccess(res, HTTP_STATUS.OK, { report });
    } catch (error) {
      console.error("Get report error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

  /**
   * Get report with full details (including relations)
   */
  getReportDetail = async (req: Request, res: Response): Promise<void> => {
    try {
      const report = await reportService.getReportDetail(req.params.id);

      if (!report) {
        return sendError(res, HTTP_STATUS.REPORT_NOT_FOUND);
      }

      sendSuccess(res, HTTP_STATUS.OK, { report });
    } catch (error) {
      console.error("Get report detail error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

  /**
   * Update a report
   */
  updateReport = [
    body("title").optional().trim(),
    body("description").optional().trim(),
    body("wasteType").optional().trim(),
    body("severityLevel")
      .optional()
      .isInt({ min: 1, max: 5 })
      .withMessage("Severity level must be between 1 and 5"),
    body("latitude")
      .optional()
      .isFloat({ min: -90, max: 90 })
      .withMessage("Invalid latitude"),
    body("longitude")
      .optional()
      .isFloat({ min: -180, max: 180 })
      .withMessage("Invalid longitude"),

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

        const report = await reportService.updateReport(
          req.params.id,
          req.body,
          userId,
          req.user?.role,
        );
        sendSuccess(res, HTTP_STATUS.OK, { report });
      } catch (error) {
        console.error("Update report error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Add images to a report (append media)
   */
  addReportImages = [
    body("imageUrls")
      .isArray({ min: 1 })
      .withMessage("imageUrls must be a non-empty array"),
    body("imageUrls.*")
      .isString()
      .withMessage("Each image URL must be a string")
      .bail()
      .trim()
      .notEmpty()
      .withMessage("Each image URL must not be empty"),

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

        const report = await reportService.addReportImages(
          req.params.id,
          userId,
          { imageUrls: req.body.imageUrls },
          req.user?.role,
        );
        sendSuccess(res, HTTP_STATUS.OK, { report });
      } catch (error) {
        console.error("Add report images error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Delete a report media file (soft delete)
   */
  deleteReportMediaFile = [
    param("mediaFileId")
      .isUUID()
      .withMessage("mediaFileId must be a valid UUID"),

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

        const report = await reportService.deleteReportMediaFile(
          req.params.id,
          req.params.mediaFileId,
          userId,
          req.user?.role,
        );
        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Report media file deleted successfully"),
          { report },
        );
      } catch (error) {
        console.error("Delete report media file error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Ban a report (admin moderation only)
   */
  adminBanReport = [
    param("id").isUUID().withMessage("Report ID must be a valid UUID"),

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
        const normalizedAdminRole = "ADMIN".toLowerCase();
        if (!normalizedRole || normalizedRole !== normalizedAdminRole) {
          return sendError(
            res,
            HTTP_STATUS.FORBIDDEN.withMessage("Only admin can ban a report"),
          );
        }

        const report = await reportService.adminBanReport(req.params.id);
        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Report banned successfully"),
          { report },
        );
      } catch (error) {
        console.error("Admin ban report error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Mark report as done (admin only)
   */
  adminMarkReportDone = [
    param("id").isUUID().withMessage("Report ID must be a valid UUID"),

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
        const normalizedAdminRole = "ADMIN".toLowerCase();
        if (!normalizedRole || normalizedRole !== normalizedAdminRole) {
          return sendError(
            res,
            HTTP_STATUS.FORBIDDEN.withMessage(
              "Only admin can mark report as done",
            ),
          );
        }

        const report = await reportService.adminMarkReportDone(req.params.id);
        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Report marked as done successfully"),
          { report },
        );
      } catch (error) {
        console.error("Admin mark report done error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Delete a report (soft delete). Owner only; admins cannot delete (use ban).
   */
  deleteReport = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      await reportService.deleteReport(req.params.id, userId, req.user?.role);
      sendSuccess(
        res,
        HTTP_STATUS.OK.withMessage("Report deleted successfully"),
      );
    } catch (error) {
      console.error("Delete report error:", error);
      if (sendHttpErrorResponse(res, error)) return;
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

  /**
   * Get current user's reports
   */
  getMyReports = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      const reports = await reportService.getUserReports(userId);
      sendSuccess(res, HTTP_STATUS.OK, { reports });
    } catch (error) {
      console.error("Get my reports error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

  /**
   * Search and discover reports
   */
  searchReports = [
    query("search").optional().trim(),
    query("status").optional().isInt(),
    query("wasteType").optional().trim(),
    query("severityLevel").optional().isInt({ min: 1, max: 5 }),
    query("latitude").optional().isFloat({ min: -90, max: 90 }),
    query("longitude").optional().isFloat({ min: -180, max: 180 }),
    query("maxDistance").optional().isInt({ min: 1 }),
    query("sortBy").optional().isIn(["distance", "createdAt", "severityLevel"]),
    query("sortOrder").optional().isIn(["asc", "desc"]),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const searchQuery: ReportSearchQuery = {
          search: req.query.search as string,
          status: req.query.status
            ? parseInt(req.query.status as string)
            : undefined,
          wasteType: req.query.wasteType as string,
          severityLevel: req.query.severityLevel
            ? parseInt(req.query.severityLevel as string)
            : undefined,
          latitude: req.query.latitude
            ? parseFloat(req.query.latitude as string)
            : undefined,
          longitude: req.query.longitude
            ? parseFloat(req.query.longitude as string)
            : undefined,
          maxDistance: req.query.maxDistance
            ? parseInt(req.query.maxDistance as string)
            : undefined,
          sortBy: req.query.sortBy as
            | "distance"
            | "createdAt"
            | "severityLevel",
          sortOrder: req.query.sortOrder as "asc" | "desc",
          page: req.query.page ? parseInt(req.query.page as string) : 1,
          limit: req.query.limit ? parseInt(req.query.limit as string) : 10,
        };

        const result = await reportService.searchReports(searchQuery);
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Search reports error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  // =====================
  // Manager Operations
  // =====================

  /**
   * Add managers to a report
   */
  addManagers = [
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
        console.error("Add managers error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Remove a manager from a report
   */
  removeManager = [
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
        console.error("Remove manager error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Get all managers for a report
   */
  getReportManagers = async (req: Request, res: Response): Promise<void> => {
    try {
      const managers = await campaignManagerService.getReportManagers(
        req.params.id,
      );
      sendSuccess(res, HTTP_STATUS.OK, { managers });
    } catch (error) {
      console.error("Get report managers error:", error);
      if (sendHttpErrorResponse(res, error)) return;
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

  // =====================
  // Task Operations
  // =====================

  /**
   * Create a task for a report
   */
  createTask = [
    body("reportId").notEmpty().withMessage("Report ID is required").trim(),
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
        const task = await campaignTaskService.createTask(
          req.user!.userId,
          req.body,
        );
        sendSuccess(res, HTTP_STATUS.CREATED, { task });
      } catch (error) {
        console.error("Create task error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Get task by ID
   */
  getTaskById = [
    body("taskId").notEmpty().withMessage("Task ID is required").trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const task = await campaignTaskService.getTaskDetail(req.body.taskId);
        if (!task) {
          return sendError(res, HTTP_STATUS.NOT_FOUND);
        }
        sendSuccess(res, HTTP_STATUS.OK, { task });
      } catch (error) {
        console.error("Get task error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Get all tasks for a report
   */
  getReportTasks = [
    body("reportId").notEmpty().withMessage("Report ID is required").trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const tasks = await campaignTaskService.getReportTasks(
          req.body.reportId,
        );
        sendSuccess(res, HTTP_STATUS.OK, { tasks });
      } catch (error) {
        console.error("Get report tasks error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Update a task
   */
  updateTask = [
    body("taskId").notEmpty().withMessage("Task ID is required").trim(),
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
        const { taskId, ...updateData } = req.body;
        if (updateData.status !== undefined) {
          updateData.status = parseInt(updateData.status as string);
        }
        const task = await campaignTaskService.updateTask(
          taskId,
          req.user!.userId,
          updateData,
        );
        sendSuccess(res, HTTP_STATUS.OK, { task });
      } catch (error) {
        console.error("Update task error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Delete a task
   */
  deleteTask = [
    body("taskId").notEmpty().withMessage("Task ID is required").trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        await campaignTaskService.deleteTask(req.body.taskId, req.user!.userId);
        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Task deleted successfully"),
        );
      } catch (error) {
        console.error("Delete task error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Assign a task to a volunteer
   */
  assignTask = [
    body("taskId").notEmpty().withMessage("Task ID is required").trim(),
    body("volunteerId")
      .notEmpty()
      .withMessage("Volunteer ID is required")
      .trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const assignment = await campaignTaskService.assignTask(
          req.body.taskId,
          req.body.volunteerId,
          req.user!.userId,
        );
        sendSuccess(res, HTTP_STATUS.CREATED, { assignment });
      } catch (error) {
        console.error("Assign task error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Unassign a volunteer from a task
   */
  unassignTask = [
    body("taskId").notEmpty().withMessage("Task ID is required").trim(),
    body("volunteerId")
      .notEmpty()
      .withMessage("Volunteer ID is required")
      .trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        await campaignTaskService.unassignTask(
          req.body.taskId,
          req.body.volunteerId,
          req.user!.userId,
        );
        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Volunteer unassigned successfully"),
        );
      } catch (error) {
        console.error("Unassign task error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Get my assigned tasks (volunteer perspective)
   */
  getMyAssignedTasks = async (req: Request, res: Response): Promise<void> => {
    try {
      const tasks = await campaignTaskService.getMyAssignedTasks(
        req.user!.userId,
      );
      sendSuccess(res, HTTP_STATUS.OK, { tasks });
    } catch (error) {
      console.error("Get assigned tasks error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

  /**
   * Update task status (volunteer perspective)
   */
  updateTaskStatus = [
    body("taskId").notEmpty().withMessage("Task ID is required").trim(),
    body("status").isInt().withMessage("Invalid status"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const task = await campaignTaskService.updateTaskStatusByVolunteer(
          req.body.taskId,
          req.user!.userId,
          parseInt(req.body.status),
        );
        sendSuccess(res, HTTP_STATUS.OK, { task });
      } catch (error) {
        console.error("Update task status error:", error);
        if (sendHttpErrorResponse(res, error)) return;
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  // Results have moved to campaign level — see campaign.routes.ts
}

// Singleton instance
export const reportController = new ReportController();
