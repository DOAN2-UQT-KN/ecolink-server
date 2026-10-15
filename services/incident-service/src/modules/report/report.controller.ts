import { Request, Response } from "express";
import { validationResult } from "express-validator";
import {
  HttpError,
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { reportService } from "./report.service";
import { ReportSearchQuery, type AdminBanReportBody, type ReportMediaFileByIdResponse } from "./report.dto";
import { normalizeQueryUuidList } from "../../utils/query-uuid-list";
import {
  addReportImagesValidators,
  adminBanReportValidators,
  createReportValidators,
  deleteReportMediaFileValidators,
  reportIdParamValidator,
  reportSearchQueryValidators,
  updateReportValidators,
} from "./report.validator";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REPORT_BATCH_QUERY_MAX_IDS = 100;

/** Repeated keys (`?statuses=21&statuses=22`) or comma-separated (`?statuses=21,22`). */
function normalizeQueryIntList(value: unknown): number[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  const raw = Array.isArray(value)
    ? value.flatMap((v) => String(v).split(","))
    : String(value).split(",");
  return [
    ...new Set(
      raw
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => parseInt(s, 10)),
    ),
  ].filter((n) => Number.isInteger(n));
}

function buildReportSearchQuery(req: Request): ReportSearchQuery {
  const statuses = normalizeQueryIntList(req.query.statuses);
  return {
    search: req.query.search as string,
    status: req.query.status
      ? parseInt(req.query.status as string, 10)
      : undefined,
    statuses: statuses.length > 0 ? statuses : undefined,
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

export class ReportController {
  constructor() { }

  /**
   * Create a new report
   */
  createReport = [
    ...createReportValidators,

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

        const idempotencyKey = req.get("Idempotency-Key")?.trim() || undefined;
        if (idempotencyKey && !UUID_RE.test(idempotencyKey)) {
          return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
            errors: [{ path: "Idempotency-Key", msg: "Idempotency-Key must be a UUID" }],
          });
        }

        // 202 for first submit and replay alike: verification runs after the response.
        const { report } = await reportService.createReport(
          userId,
          req.body,
          req.headers.authorization,
          idempotencyKey,
        );
        sendSuccess(res, HTTP_STATUS.ACCEPTED, { report });
      } catch (error) {
        const retryAfter = error instanceof HttpError ? error.data?.retryAfter : undefined;
        if (typeof retryAfter === "string") {
          const seconds = Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000);
          res.set("Retry-After", String(Math.max(1, seconds)));
        }
        if (sendHttpErrorResponse(res, error)) return;
        console.error("Create report error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

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
   * All reports with status ACTIVE (no pagination).
   */
  getAllActiveReports = async (
    _req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const reports = await reportService.getAllActiveReports(_req.user?.userId);
      sendSuccess(res, HTTP_STATUS.OK, { reports });
    } catch (error) {
      console.error("Get all active reports error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

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
    ...reportIdParamValidator,

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
    ...updateReportValidators,

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
          undefined,
          req.headers.authorization,
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
    ...addReportImagesValidators,

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
          {
            imageUrls: req.body.imageUrls,
            mediaCaptures: req.body.mediaCaptures,
          },
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
    ...deleteReportMediaFileValidators,

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
   * Ban a report (admin moderation only). Requires `reject_reason`.
   */
  adminBanReport = [
    ...adminBanReportValidators,

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

        const { rejectReason } = req.body as AdminBanReportBody;
        const report = await reportService.adminBanReport(
          req.params.id,
          userId,
          rejectReason,
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
    ...reportIdParamValidator,

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
    ...reportIdParamValidator,

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
