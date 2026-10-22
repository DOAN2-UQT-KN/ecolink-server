import { Request, Response } from "express";
import { body, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { VoteResourceType } from "../../constants/status.enum";
import { voteService } from "./vote.service";

const voteResourceTypeValues = Object.values(VoteResourceType).filter(
  (v): v is VoteResourceType => typeof v === "string",
);

const voteActionValidators = [
  body("resourceId").isUUID("loose").withMessage("resourceId must be a valid UUID"),
  body("resourceType")
    .isIn(voteResourceTypeValues)
    .withMessage(`resourceType must be one of: ${voteResourceTypeValues.join(", ")}`),
];

export class VoteController {
  upvote = [
    ...voteActionValidators,
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
        const vote = await voteService.upvote(userId, {
          resourceId: req.body.resourceId,
          resourceType: req.body.resourceType as VoteResourceType,
        });
        return sendSuccess(res, HTTP_STATUS.OK, { vote });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];

  downvote = [
    ...voteActionValidators,
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
        const vote = await voteService.downvote(userId, {
          resourceId: req.body.resourceId,
          resourceType: req.body.resourceType as VoteResourceType,
        });
        return sendSuccess(res, HTTP_STATUS.OK, { vote });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];
}

export const voteController = new VoteController();
