import { Request, Response } from "express";
import { body, param, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { OwnerChangeInput, ownerChangeService } from "./owner-change.service";

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

export class OwnerChangeController {
  create = [
    orgId,
    body("type").isIn(["ADD_OWNER", "REMOVE_OWNER"]),
    body("owners").optional().isArray({ min: 1, max: 5 }),
    body("owners.*.userId").optional({ values: "null" }).isUUID(),
    body("owners.*.email").optional({ values: "null" }).isString().isLength({ max: 320 }),
    body("owners.*.fullName").optional().isString().isLength({ max: 200 }),
    body("targetUserId").optional({ values: "null" }).isUUID(),
    body("demoteTo").optional({ values: "null" }).isIn(["ADMIN", "MEMBER"]),
    body("replacement").optional({ values: "null" }).isObject(),
    body("replacement.userId").optional({ values: "null" }).isUUID(),
    body("replacement.email").optional({ values: "null" }).isString().isLength({ max: 320 }),
    body("replacement.fullName").optional().isString().isLength({ max: 200 }),
    body("reason").optional({ values: "null" }).isString().isLength({ max: 1000 }),
    authed(async (req, res, userId, email) => {
      const change = await ownerChangeService.create(req.params.id, userId, email, {
        type: String(req.body.type),
        owners: req.body.owners,
        targetUserId: req.body.targetUserId ?? undefined,
        demoteTo: req.body.demoteTo ?? null,
        replacement: req.body.replacement ?? null,
        reason: req.body.reason ?? null,
      } as OwnerChangeInput);
      sendSuccess(res, HTTP_STATUS.CREATED, { change });
    }),
  ];

  list = [
    orgId,
    authed(async (req, res, userId) => {
      const changes = await ownerChangeService.list(req.params.id, userId);
      sendSuccess(res, HTTP_STATUS.OK, { changes });
    }),
  ];

  approve = [
    orgId,
    applicationId,
    authed(async (req, res, userId) => {
      await ownerChangeService.approve(req.params.id, req.params.applicationId, userId);
      sendSuccess(res, HTTP_STATUS.OK);
    }),
  ];

  reject = [
    orgId,
    applicationId,
    body("note").optional({ values: "null" }).isString().isLength({ max: 1000 }),
    authed(async (req, res, userId) => {
      await ownerChangeService.reject(
        req.params.id,
        req.params.applicationId,
        userId,
        req.body.note ?? null,
      );
      sendSuccess(res, HTTP_STATUS.OK);
    }),
  ];

  cancel = [
    orgId,
    applicationId,
    authed(async (req, res, userId) => {
      await ownerChangeService.cancel(req.params.id, req.params.applicationId, userId);
      sendSuccess(res, HTTP_STATUS.OK);
    }),
  ];

  resend = [
    orgId,
    applicationId,
    param("candidateId").isUUID(),
    authed(async (req, res, userId) => {
      await ownerChangeService.resend(
        req.params.id,
        req.params.applicationId,
        req.params.candidateId,
        userId,
      );
      sendSuccess(res, HTTP_STATUS.OK);
    }),
  ];
}

export const ownerChangeController = new OwnerChangeController();
