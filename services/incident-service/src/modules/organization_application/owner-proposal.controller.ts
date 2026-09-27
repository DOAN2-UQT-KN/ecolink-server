import { Request, Response } from "express";
import { body, param, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { OwnerProposalInput, ownerProposalService } from "./owner-proposal.service";

function authed(
  handler: (req: Request, res: Response, userId: string, email: string) => Promise<void>,
) {
  return async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    const userId = req.user?.userId;
    if (!userId) {
      sendError(res, HTTP_STATUS.UNAUTHORIZED);
      return;
    }
    try {
      await handler(req, res, userId, req.user?.email ?? "");
    } catch (error) {
      if (sendHttpErrorResponse(res, error)) return;
      throw error;
    }
  };
}

const orgId = param("id").isUUID();
const applicationId = param("applicationId").isUUID();

export class OwnerProposalController {
  create = [
    orgId,
    body("owners").isArray({ min: 1, max: 5 }),
    body("owners.*.userId").optional({ values: "null" }).isUUID(),
    body("owners.*.email").optional({ values: "null" }).isString().isLength({ max: 320 }),
    body("owners.*.fullName").optional().isString().isLength({ max: 200 }),
    body("reason").optional({ values: "null" }).isString().isLength({ max: 1000 }),
    authed(async (req, res, userId, email) => {
      const proposal = await ownerProposalService.create(
        req.params.id,
        userId,
        email,
        (req.body.owners ?? []) as OwnerProposalInput[],
        req.body.reason ?? null,
      );
      sendSuccess(res, HTTP_STATUS.CREATED, { proposal });
    }),
  ];

  list = [
    orgId,
    authed(async (req, res, userId) => {
      const proposals = await ownerProposalService.list(req.params.id, userId);
      sendSuccess(res, HTTP_STATUS.OK, { proposals });
    }),
  ];

  cancel = [
    orgId,
    applicationId,
    authed(async (req, res, userId) => {
      await ownerProposalService.cancel(req.params.id, req.params.applicationId, userId);
      sendSuccess(res, HTTP_STATUS.OK);
    }),
  ];

  resend = [
    orgId,
    applicationId,
    param("candidateId").isUUID(),
    authed(async (req, res, userId) => {
      await ownerProposalService.resend(
        req.params.id,
        req.params.applicationId,
        req.params.candidateId,
        userId,
      );
      sendSuccess(res, HTTP_STATUS.OK);
    }),
  ];
}

export const ownerProposalController = new OwnerProposalController();
