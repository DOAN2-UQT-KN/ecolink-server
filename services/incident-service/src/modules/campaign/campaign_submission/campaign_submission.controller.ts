import { Request, Response } from "express";
import { body, param, query, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendSuccess,
} from "../../../constants/http-status";
import { campaignSubmissionService } from "./campaign_submission.service";
import type { CampaignSubmissionsListQuery } from "./campaign_submission.dto";

export class CampaignSubmissionController {
  constructor() {}

  /**
   * POST /api/v1/campaigns/:id/submissions
   * Body: title, description (optional). Draft results are attached from the DB, not sent in the body.
   */
  createSubmission = [
    body("title").optional().trim(),
    body("description").optional().trim(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const managerId = req.user?.userId;
        if (!managerId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);

        const submission = await campaignSubmissionService.createSubmission(
          req.params.id,
          managerId,
          req.body,
        );
        sendSuccess(res, HTTP_STATUS.CREATED, { submission });
      } catch (error) {
        console.error("Create submission error:", error);
        if (error instanceof Error) {
          if (error.message.includes("managers can create")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * GET /api/v1/campaigns/:id/submissions
   */
  getSubmissions = [
    param("id").isUUID().withMessage("Campaign ID must be a valid UUID"),
    query("status").optional().isInt(),
    query("submittedBy").optional().isUUID(),
    query("search").optional().trim(),
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
        const q: CampaignSubmissionsListQuery = {
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
          submittedBy: req.query.submittedBy
            ? String(req.query.submittedBy).trim()
            : undefined,
          search: req.query.search
            ? String(req.query.search).trim()
            : undefined,
          sortBy: req.query.sortBy as CampaignSubmissionsListQuery["sortBy"],
          sortOrder:
            req.query.sortOrder as CampaignSubmissionsListQuery["sortOrder"],
        };

        const result = await campaignSubmissionService.getSubmissionsByCampaign(
          req.params.id,
          q,
        );
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Get submissions error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * GET /api/v1/campaigns/:id/submissions/current-results
   * Draft campaign results not yet linked to any submission (campaignSubmissionId is null).
   */
  getCurrentResults = async (req: Request, res: Response): Promise<void> => {
    try {
      const results = await campaignSubmissionService.getUnsubmittedResults(
        req.params.id,
      );
      sendSuccess(res, HTTP_STATUS.OK, { results });
    } catch (error) {
      console.error("Get current results error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

  /**
   * GET /api/v1/campaigns/submissions/:submissionId
   */
  getSubmissionDetail = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const submission = await campaignSubmissionService.getSubmissionDetail(
        req.params.submissionId,
      );
      if (!submission) {
        return sendError(
          res,
          HTTP_STATUS.NOT_FOUND.withMessage("Submission not found"),
        );
      }
      sendSuccess(res, HTTP_STATUS.OK, { submission });
    } catch (error) {
      console.error("Get submission detail error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

  /**
   * POST /api/v1/campaigns/submissions/:submissionId/results
   */
  addResult = [
    body("title").notEmpty().withMessage("Title is required").trim(),
    body("description").optional().trim(),
    body("mediaUrls").optional().isArray(),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const managerId = req.user?.userId;
        if (!managerId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);

        const result = await campaignSubmissionService.addResultToSubmission(
          req.params.submissionId,
          managerId,
          req.body,
        );
        sendSuccess(res, HTTP_STATUS.CREATED, { result });
      } catch (error) {
        console.error("Add result error:", error);
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            return sendError(res, HTTP_STATUS.NOT_FOUND);
          }
          if (error.message.includes("submitter")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * PUT /api/v1/campaigns/submissions/:submissionId/process
   */
  processSubmission = [
    body("approved").isBoolean().withMessage("approved must be a boolean"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const managerId = req.user?.userId;
        if (!managerId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);

        const submission = await campaignSubmissionService.processSubmission(
          req.params.submissionId,
          managerId,
          req.body.approved,
        );
        sendSuccess(res, HTTP_STATUS.OK, { submission });
      } catch (error) {
        console.error("Process submission error:", error);
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            return sendError(res, HTTP_STATUS.NOT_FOUND);
          }
          if (error.message.includes("managers can process")) {
            return sendError(res, HTTP_STATUS.FORBIDDEN);
          }
          if (error.message.includes("already processed")) {
            return sendError(
              res,
              HTTP_STATUS.CONFLICT.withMessage("Submission already processed"),
            );
          }
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];
}

export const campaignSubmissionController =
  new CampaignSubmissionController();
