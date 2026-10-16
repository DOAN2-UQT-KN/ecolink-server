import { Request, Response } from "express";
import { validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { isPlatformAdmin } from "../campaign/campaign-access.service";
import { reportIdParamValidator } from "../report/report.validator";
import { moderationService, type ModerationDecision, type ModerationTab } from "./moderation.service";
import { verificationViewService } from "./verification-view.service";
import { moderateValidators, moderationQueueValidators } from "./verification.validator";

type Handler = (req: Request, res: Response, viewer: { userId: string; isAdmin: boolean }) => Promise<void>;

/** Validation, auth and error mapping shared by the verification / moderation endpoints. */
function endpoint(name: string, handler: Handler, { adminOnly }: { adminOnly: boolean }) {
  return async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
    }
    const userId = req.user?.userId;
    if (!userId) return sendError(res, HTTP_STATUS.UNAUTHORIZED);
    const isAdmin = isPlatformAdmin(req.user?.role);
    if (adminOnly && !isAdmin) {
      return sendError(res, HTTP_STATUS.FORBIDDEN.withMessage("Only admin can moderate reports"));
    }
    try {
      await handler(req, res, { userId, isAdmin });
    } catch (error) {
      if (sendHttpErrorResponse(res, error)) return;
      console.error(`${name} error:`, error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };
}

export const verificationController = {
  /** Owner: public view; admin: full view (specs/006 P09). */
  getVerification: [
    ...reportIdParamValidator,
    endpoint(
      "Get report verification",
      async (req, res, viewer) => {
        const verification = await verificationViewService.getForViewer(req.params.id, viewer);
        sendSuccess(res, HTTP_STATUS.OK, { verification });
      },
      { adminOnly: false },
    ),
  ],

  listVerifications: [
    ...reportIdParamValidator,
    endpoint(
      "List report verifications",
      async (req, res) => {
        const verifications = await verificationViewService.listForAdmin(req.params.id);
        sendSuccess(res, HTTP_STATUS.OK, { verifications });
      },
      { adminOnly: true },
    ),
  ],

  moderationQueue: [
    ...moderationQueueValidators,
    endpoint(
      "Moderation queue",
      async (req, res) => {
        const data = await moderationService.queue({
          flag: (req.query.flag as ModerationTab | undefined) ?? "REVIEW",
          page: req.query.page ? Number(req.query.page) : 1,
          limit: req.query.limit ? Number(req.query.limit) : 20,
        });
        sendSuccess(res, HTTP_STATUS.OK, data);
      },
      { adminOnly: true },
    ),
  ],

  moderate: [
    ...moderateValidators,
    endpoint(
      "Moderate report",
      async (req, res, viewer) => {
        const report = await moderationService.moderate(req.params.id, viewer.userId, req.body as ModerationDecision);
        sendSuccess(res, HTTP_STATUS.OK.withMessage("Report moderated"), { report });
      },
      { adminOnly: true },
    ),
  ],
};
