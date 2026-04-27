import { Request, Response } from "express";
import { body, param, query, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { reportService } from "./report.service";
import { ReportSearchQuery, type ReportMediaFileByIdResponse } from "./report.dto";
import { normalizeQueryUuidList } from "../../utils/query-uuid-list";

const REPORT_BATCH_QUERY_MAX_IDS = 100;

function buildReportSearchQuery(req: Request): ReportSearchQuery {
  return {
    search: req.query.search as string,
    status: req.query.status
      ? parseInt(req.query.status as string, 10)
      : undefined,
    wasteType: req.query.wasteType as string,
    severityLevel: req.query.severityLevel
      ? parseInt(req.query.severityLevel as string, 10)
      : undefined,
    latitude: req.query.latitude
      ? parseFloat(req.query.latitude as string)
      : undefined,
    longitude: req.query.longitude
      ? parseFloat(req.query.longitude as string)
      : undefined,
    maxDistance: req.query.maxDistance
      ? parseInt(req.query.maxDistance as string, 10)
      : undefined,
    sortBy: req.query.sortBy as
      | "distance"
      | "createdAt"
      | "severityLevel",
    sortOrder: req.query.sortOrder as "asc" | "desc",
    page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 10,
  };
}

const reportSearchQueryValidators = [
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
];

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
    body("detailAddress").optional().trim(),
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
   * @query reportIds — required; comma-separated or repeated; max 100 UUIDs
   */
  getReportsByIds = [
    async (req: Request, res: Response): Promise<void> => {
      const parsed = normalizeQueryUuidList(
        req.query.reportIds,
        REPORT_BATCH_QUERY_MAX_IDS,
      );

      if (parsed.kind === "invalid") {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: [
            {
              msg: `reportIds must be valid UUIDs with at most ${REPORT_BATCH_QUERY_MAX_IDS} values (comma-separated or repeated keys)`,
              path: "query",
            },
          ],
        });
      }

      if (parsed.kind === "absent" || parsed.ids.length === 0) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: [
            {
              msg: "reportIds is required",
              path: "query",
            },
          ],
        });
      }

      try {
        const reports = await reportService.getReportsByIds(
          parsed.ids,
          req.user?.userId,
        );
        sendSuccess(res, HTTP_STATUS.OK, { reports });
      } catch (error) {
        console.error("Get reports by ids error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * @query mediaFileIds — required; comma-separated or repeated; max 100 UUIDs (report_media_files.id)
   */
  getReportMediaFilesByIds = [
    async (req: Request, res: Response): Promise<void> => {
      const parsed = normalizeQueryUuidList(
        req.query.mediaFileIds ?? req.query.media_file_ids,
        REPORT_BATCH_QUERY_MAX_IDS,
      );

      if (parsed.kind === "invalid") {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: [
            {
              msg: `mediaFileIds must be valid UUIDs with at most ${REPORT_BATCH_QUERY_MAX_IDS} values (comma-separated or repeated keys)`,
              path: "query",
            },
          ],
        });
      }

      if (parsed.kind === "absent" || parsed.ids.length === 0) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: [
            {
              msg: "mediaFileIds is required",
              path: "query",
            },
          ],
        });
      }

      if (!req.user?.userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      try {
        const mediaFiles: ReportMediaFileByIdResponse[] =
          await reportService.getReportMediaFilesByIds(
            parsed.ids,
            req.user.userId,
          );
        sendSuccess(res, HTTP_STATUS.OK, { mediaFiles });
      } catch (error) {
        console.error("Get report media files by ids error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Get report by ID
   */
  getReportById = async (req: Request, res: Response): Promise<void> => {
    try {
      const report = await reportService.getReportById(
        req.params.id,
        req.user?.userId,
      );

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
      const report = await reportService.getReportDetail(
        req.params.id,
        req.user?.userId,
      );

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
   * Whether all background jobs for this report (e.g. AI analysis) are finished
   * (nothing pending or in process).
   */
  getReportBackgroundJobsStatus = [
    param("id").isUUID().withMessage("Report ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        if (!req.user?.userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const backgroundJobs = await reportService.getReportBackgroundJobsStatus(
          req.params.id,
        );

        if (!backgroundJobs) {
          return sendError(res, HTTP_STATUS.REPORT_NOT_FOUND);
        }

        sendSuccess(res, HTTP_STATUS.OK, { backgroundJobs });
      } catch (error) {
        console.error("Get report background jobs status error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

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
    body("detailAddress").optional().trim(),

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

        const report = await reportService.adminBanReport(
          req.params.id,
          userId,
        );
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
   * Verify a report (admin only). Sets `is_verify` and status pending (eligible for campaigns).
   */
  adminVerifyReport = [
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
        if (!normalizedRole || normalizedRole !== "admin") {
          return sendError(
            res,
            HTTP_STATUS.FORBIDDEN.withMessage("Only admin can verify a report"),
          );
        }

        const report = await reportService.adminVerifyReport(
          req.params.id,
          userId,
        );
        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Report verified successfully"),
          { report },
        );
      } catch (error) {
        console.error("Admin verify report error:", error);
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

        const report = await reportService.adminMarkReportDone(
          req.params.id,
          userId,
        );
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
   * Get current user's reports: same query params as GET /search, including pagination (`page`, `limit`).
   * Response: `{ reports, total, page, limit, totalPages }` (wrapped in API envelope).
   */
  getMyReports = [
    ...reportSearchQueryValidators,

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

        const result = await reportService.searchMyReports(
          userId,
          buildReportSearchQuery(req),
        );
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Get my reports error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * Search and discover reports
   */
  searchReports = [
    ...reportSearchQueryValidators,

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const result = await reportService.searchReports(
          buildReportSearchQuery(req),
          req.user?.userId,
        );
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Search reports error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

}

// Singleton instance
export const reportController = new ReportController();
