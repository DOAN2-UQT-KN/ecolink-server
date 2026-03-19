import { Request, Response } from "express";
import { body, query, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendSuccess,
} from "../../constants/http-status";
import { reportService } from "./report.service";
import { reportManagerService } from "./report_manager/report_manager.service";
import { reportTaskService } from "./report_task/report_task.service";
import { reportVolunteerService } from "./report_volunteer/report_volunteer.service";
import { reportResultService } from "./report_result/report_result.service";
import { ReportSearchQuery } from "./report.dto";
import {
  ReportStatus,
  TaskStatus,
  JoinRequestStatus,
} from "../../constants/status.enum";

export class ReportController {
  constructor() {}

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
    body("status")
      .optional()
      .isIn(Object.values(ReportStatus))
      .withMessage("Invalid status"),
    body("imageUrls")
      .optional({ nullable: true })
      .isArray()
      .withMessage("imageUrls must be an array"),
    body("imageUrls.*")
      .optional()
      .isString()
      .withMessage("Each image_url must be a string")
      .bail()
      .trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const report = await reportService.updateReport(
          req.params.id,
          req.body,
        );
        sendSuccess(res, HTTP_STATUS.OK, { report });
      } catch (error) {
        console.error("Update report error:", error);
        if (error instanceof Error && error.message.includes("not found")) {
          return sendError(res, HTTP_STATUS.REPORT_NOT_FOUND);
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Delete a report (soft delete)
   */
  deleteReport = async (req: Request, res: Response): Promise<void> => {
    try {
      await reportService.deleteReport(req.params.id);
      sendSuccess(
        res,
        HTTP_STATUS.OK.withMessage("Report deleted successfully"),
      );
    } catch (error) {
      console.error("Delete report error:", error);
      if (error instanceof Error && error.message.includes("not found")) {
        return sendError(res, HTTP_STATUS.REPORT_NOT_FOUND);
      }
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
    query("status").optional().isIn(Object.values(ReportStatus)),
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
          status: req.query.status as keyof typeof ReportStatus,
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

        const managers = await reportManagerService.addManagers(
          req.params.id,
          req.body,
          assignedBy,
        );
        sendSuccess(res, HTTP_STATUS.CREATED, { managers });
      } catch (error) {
        console.error("Add managers error:", error);
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            return sendError(res, HTTP_STATUS.REPORT_NOT_FOUND);
          }
          if (error.message.includes("Only the reporter")) {
            return sendError(res, HTTP_STATUS.NOT_A_REPORTER);
          }
        }
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

        await reportManagerService.removeManager(
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
        if (error instanceof Error) {
          if (error.message.includes("Report not found")) {
            return sendError(res, HTTP_STATUS.REPORT_NOT_FOUND);
          }
          if (error.message.includes("Only the reporter")) {
            return sendError(res, HTTP_STATUS.NOT_A_REPORTER);
          }
          if (error.message.includes("not a manager")) {
            return sendError(
              res,
              HTTP_STATUS.NOT_FOUND.withMessage("User is not a manager"),
            );
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Get all managers for a report
   */
  getReportManagers = async (req: Request, res: Response): Promise<void> => {
    try {
      const managers = await reportManagerService.getReportManagers(
        req.params.id,
      );
      sendSuccess(res, HTTP_STATUS.OK, { managers });
    } catch (error) {
      console.error("Get report managers error:", error);
      if (error instanceof Error && error.message.includes("not found")) {
        return sendError(res, HTTP_STATUS.REPORT_NOT_FOUND);
      }
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
        const task = await reportTaskService.createTask(
          req.user!.userId,
          req.body,
        );
        sendSuccess(res, HTTP_STATUS.CREATED, { task });
      } catch (error) {
        console.error("Create task error:", error);
        if (error instanceof Error) {
          if (error.message.includes("Report not found")) {
            return sendError(res, HTTP_STATUS.REPORT_NOT_FOUND);
          }
          if (error.message.includes("Only reporter or managers")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
        }
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
        const task = await reportTaskService.getTaskDetail(req.body.taskId);
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
        const tasks = await reportTaskService.getReportTasks(req.body.reportId);
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
    body("status").optional().isIn(Object.values(TaskStatus)),
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
        const task = await reportTaskService.updateTask(
          taskId,
          req.user!.userId,
          updateData,
        );
        sendSuccess(res, HTTP_STATUS.OK, { task });
      } catch (error) {
        console.error("Update task error:", error);
        if (error instanceof Error) {
          if (error.message.includes("Task not found")) {
            return sendError(res, HTTP_STATUS.NOT_FOUND);
          }
          if (error.message.includes("Only reporter or managers")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
        }
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
        await reportTaskService.deleteTask(req.body.taskId, req.user!.userId);
        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Task deleted successfully"),
        );
      } catch (error) {
        console.error("Delete task error:", error);
        if (error instanceof Error) {
          if (error.message.includes("Task not found")) {
            return sendError(res, HTTP_STATUS.NOT_FOUND);
          }
          if (error.message.includes("Only reporter or managers")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
        }
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
        const assignment = await reportTaskService.assignTask(
          req.body.taskId,
          req.body.volunteerId,
          req.user!.userId,
        );
        sendSuccess(res, HTTP_STATUS.CREATED, { assignment });
      } catch (error) {
        console.error("Assign task error:", error);
        if (error instanceof Error) {
          if (error.message.includes("Task not found")) {
            return sendError(res, HTTP_STATUS.NOT_FOUND);
          }
          if (error.message.includes("Only reporter or managers")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
          if (error.message.includes("already assigned")) {
            return sendError(res, HTTP_STATUS.CONFLICT);
          }
          if (error.message.includes("must be approved")) {
            return sendError(
              res,
              HTTP_STATUS.FORBIDDEN.withMessage(
                "Volunteer must be approved first",
              ),
            );
          }
        }
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
        await reportTaskService.unassignTask(
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
        if (error instanceof Error) {
          if (error.message.includes("Task not found")) {
            return sendError(res, HTTP_STATUS.NOT_FOUND);
          }
          if (error.message.includes("Only reporter or managers")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
          if (error.message.includes("not assigned")) {
            return sendError(
              res,
              HTTP_STATUS.NOT_FOUND.withMessage(
                "Volunteer not assigned to this task",
              ),
            );
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Get my assigned tasks (volunteer perspective)
   */
  getMyAssignedTasks = async (req: Request, res: Response): Promise<void> => {
    try {
      const tasks = await reportTaskService.getMyAssignedTasks(
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
    body("status")
      .isIn([TaskStatus.IN_PROGRESS, TaskStatus.COMPLETED])
      .withMessage("Invalid status"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const task = await reportTaskService.updateTaskStatusByVolunteer(
          req.body.taskId,
          req.user!.userId,
          req.body.status,
        );
        sendSuccess(res, HTTP_STATUS.OK, { task });
      } catch (error) {
        console.error("Update task status error:", error);
        if (error instanceof Error) {
          if (error.message.includes("Task not found")) {
            return sendError(res, HTTP_STATUS.NOT_FOUND);
          }
          if (error.message.includes("not assigned")) {
            return sendError(
              res,
              HTTP_STATUS.FORBIDDEN.withMessage(
                "You are not assigned to this task",
              ),
            );
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  // =====================
  // Volunteer Operations
  // =====================

  /**
   * Create a join request for a report
   */
  createJoinRequest = [
    body("reportId").notEmpty().withMessage("Report ID is required").trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const joinRequest = await reportVolunteerService.createJoinRequest(
          req.body.reportId,
          req.user!.userId,
        );
        sendSuccess(res, HTTP_STATUS.CREATED, { joinRequest });
      } catch (error) {
        console.error("Create join request error:", error);
        if (error instanceof Error) {
          if (error.message.includes("Report not found")) {
            return sendError(res, HTTP_STATUS.NOT_FOUND);
          }
          if (error.message.includes("Cannot join your own report")) {
            return sendError(
              res,
              HTTP_STATUS.FORBIDDEN.withMessage("Cannot join your own report"),
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
   * Get join requests for a report
   */
  getJoinRequests = [
    body("reportId").notEmpty().withMessage("Report ID is required").trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const joinRequests =
          await reportVolunteerService.getJoinRequestsByReportId(
            req.body.reportId,
          );
        sendSuccess(res, HTTP_STATUS.OK, { joinRequests });
      } catch (error) {
        console.error("Get join requests error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Get my join requests
   */
  getMyJoinRequests = async (req: Request, res: Response): Promise<void> => {
    try {
      const joinRequests = await reportVolunteerService.getMyJoinRequests(
        req.user!.userId,
      );
      sendSuccess(res, HTTP_STATUS.OK, { joinRequests });
    } catch (error) {
      console.error("Get my join requests error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

  /**
   * Approve or reject a join request
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
        const status = req.body.approved
          ? JoinRequestStatus.APPROVED
          : JoinRequestStatus.REJECTED;
        const joinRequest = await reportVolunteerService.processJoinRequest(
          req.body.requestId,
          req.user!.userId,
          status,
        );
        sendSuccess(res, HTTP_STATUS.OK, { joinRequest });
      } catch (error) {
        console.error("Process join request error:", error);
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            return sendError(res, HTTP_STATUS.NOT_FOUND);
          }
          if (error.message.includes("Only the reporter")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
          if (error.message.includes("already processed")) {
            return sendError(
              res,
              HTTP_STATUS.CONFLICT.withMessage(
                "Join request already processed",
              ),
            );
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Cancel a join request
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
        await reportVolunteerService.cancelJoinRequest(
          req.body.requestId,
          req.user!.userId,
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
              HTTP_STATUS.CONFLICT.withMessage(
                "Can only cancel pending requests",
              ),
            );
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Get approved volunteers for a report
   */
  getApprovedVolunteers = [
    body("reportId").notEmpty().withMessage("Report ID is required").trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const volunteers = await reportVolunteerService.getApprovedVolunteers(
          req.body.reportId,
        );
        sendSuccess(res, HTTP_STATUS.OK, { volunteers });
      } catch (error) {
        console.error("Get approved volunteers error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  // =====================
  // Result Operations
  // =====================

  /**
   * Submit a result for a report
   */
  submitResult = [
    body("reportId").notEmpty().withMessage("Report ID is required").trim(),
    body("description").optional().trim(),
    body("mediaFiles")
      .optional()
      .isArray()
      .withMessage("Media files must be an array"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const result = await reportResultService.submitResult(
          req.user!.userId,
          req.body,
        );
        sendSuccess(res, HTTP_STATUS.CREATED, { result });
      } catch (error) {
        console.error("Submit result error:", error);
        if (error instanceof Error) {
          if (error.message.includes("Report not found")) {
            return sendError(res, HTTP_STATUS.NOT_FOUND);
          }
          if (error.message.includes("Only managers")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Get results for a report
   */
  getReportResults = [
    body("reportId").notEmpty().withMessage("Report ID is required").trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const results = await reportResultService.getReportResults(
          req.body.reportId,
        );
        sendSuccess(res, HTTP_STATUS.OK, { results });
      } catch (error) {
        console.error("Get report results error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Get result detail by ID
   */
  getResultDetail = [
    body("resultId").notEmpty().withMessage("Result ID is required").trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const result = await reportResultService.getResultDetail(
          req.body.resultId,
        );
        if (!result) {
          return sendError(
            res,
            HTTP_STATUS.NOT_FOUND.withMessage("Result not found"),
          );
        }
        sendSuccess(res, HTTP_STATUS.OK, { result });
      } catch (error) {
        console.error("Get result detail error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Update a result
   */
  updateResult = [
    body("resultId").notEmpty().withMessage("Result ID is required").trim(),
    body("description").optional().trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const { resultId, ...updateData } = req.body;
        const result = await reportResultService.updateResult(
          resultId,
          req.user!.userId,
          updateData,
        );
        sendSuccess(res, HTTP_STATUS.OK, { result });
      } catch (error) {
        console.error("Update result error:", error);
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            return sendError(res, HTTP_STATUS.NOT_FOUND);
          }
          if (error.message.includes("Only the submitting manager")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
          if (error.message.includes("only update pending")) {
            return sendError(
              res,
              HTTP_STATUS.CONFLICT.withMessage(
                "Can only update pending results",
              ),
            );
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Approve or reject a result
   */
  processResult = [
    body("resultId").notEmpty().withMessage("Result ID is required").trim(),
    body("approved").isBoolean().withMessage("Approved must be boolean"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const result = await reportResultService.processResult(
          req.body.resultId,
          req.user!.userId,
          req.body.approved,
        );
        sendSuccess(res, HTTP_STATUS.OK, { result });
      } catch (error) {
        console.error("Process result error:", error);
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            return sendError(res, HTTP_STATUS.NOT_FOUND);
          }
          if (error.message.includes("Only the reporter")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
          if (error.message.includes("already processed")) {
            return sendError(
              res,
              HTTP_STATUS.CONFLICT.withMessage("Result already processed"),
            );
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];
}

// Singleton instance
export const reportController = new ReportController();
