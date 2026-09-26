import { Request, Response } from "express";
import { body, param, query, validationResult } from "express-validator";
import { InvitationStatus } from "@da2/constants";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { organizationInvitationService } from "./organization-invitation.service";

function failedValidation(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
  return true;
}

/** Runs an authenticated handler with the usual validation / auth / HttpError plumbing. */
function authed(
  handler: (req: Request, res: Response, userId: string) => Promise<void>,
) {
  return async (req: Request, res: Response): Promise<void> => {
    if (failedValidation(req, res)) return;
    const userId = req.user?.userId;
    if (!userId) {
      sendError(res, HTTP_STATUS.UNAUTHORIZED);
      return;
    }
    try {
      await handler(req, res, userId);
    } catch (error) {
      if (sendHttpErrorResponse(res, error)) return;
      throw error;
    }
  };
}

function open(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    if (failedValidation(req, res)) return;
    try {
      await handler(req, res);
    } catch (error) {
      if (sendHttpErrorResponse(res, error)) return;
      throw error;
    }
  };
}

const orgId = param("id").isUUID();
const invitationId = param("invitationId").isUUID();
const token = param("token").notEmpty().isLength({ max: 128 });

export class OrganizationInvitationController {
  searchUsers = [
    orgId,
    query("q").isString().trim().isLength({ min: 2, max: 100 }),
    authed(async (req, res, userId) => {
      const users = await organizationInvitationService.searchUsers(
        req.params.id,
        userId,
        String(req.query.q),
      );
      sendSuccess(res, HTTP_STATUS.OK, { users });
    }),
  ];

  create = [
    orgId,
    body("userId").isUUID().withMessage("user_id is required"),
    authed(async (req, res, userId) => {
      const invitation = await organizationInvitationService.create(
        req.params.id,
        userId,
        String(req.body.userId),
      );
      sendSuccess(res, HTTP_STATUS.CREATED, { invitation });
    }),
  ];

  list = [
    orgId,
    query("status").optional().isIn(Object.values(InvitationStatus)),
    authed(async (req, res, userId) => {
      const invitations = await organizationInvitationService.list(
        req.params.id,
        userId,
        req.query.status ? String(req.query.status) : undefined,
      );
      sendSuccess(res, HTTP_STATUS.OK, { invitations });
    }),
  ];

  approve = [
    orgId,
    invitationId,
    authed(async (req, res, userId) => {
      const invitation = await organizationInvitationService.approve(
        req.params.id,
        req.params.invitationId,
        userId,
      );
      sendSuccess(res, HTTP_STATUS.OK, { invitation });
    }),
  ];

  reject = [
    orgId,
    invitationId,
    authed(async (req, res, userId) => {
      const invitation = await organizationInvitationService.reject(
        req.params.id,
        req.params.invitationId,
        userId,
      );
      sendSuccess(res, HTTP_STATUS.OK, { invitation });
    }),
  ];

  cancel = [
    orgId,
    invitationId,
    authed(async (req, res, userId) => {
      await organizationInvitationService.cancel(
        req.params.id,
        req.params.invitationId,
        userId,
      );
      sendSuccess(res, HTTP_STATUS.OK);
    }),
  ];

  getByToken = [
    token,
    open(async (req, res) => {
      const invitation = await organizationInvitationService.getByToken(
        req.params.token,
        req.user?.userId ?? null,
      );
      sendSuccess(res, HTTP_STATUS.OK, { invitation });
    }),
  ];

  accept = [
    token,
    open(async (req, res) => {
      const result = await organizationInvitationService.accept(req.params.token);
      sendSuccess(res, HTTP_STATUS.OK, result);
    }),
  ];

  decline = [
    token,
    open(async (req, res) => {
      await organizationInvitationService.decline(req.params.token);
      sendSuccess(res, HTTP_STATUS.OK);
    }),
  ];
}

export const organizationInvitationController = new OrganizationInvitationController();
