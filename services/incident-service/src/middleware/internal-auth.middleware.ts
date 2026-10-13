import { Request, Response, NextFunction } from "express";
import { HTTP_STATUS, sendError } from "../constants/http-status";

/**
 * Guards routes that only other services may call (e.g. the approval saga creating an
 * organization). Server-to-server callers must send `x-internal-api-key`.
 */
export const requireInternalIncidentApiKey = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const expected = process.env.INTERNAL_INCIDENT_API_KEY;
  if (!expected) {
    sendError(
      res,
      HTTP_STATUS.INTERNAL_SERVER_ERROR.withMessage(
        "INTERNAL_INCIDENT_API_KEY is not configured",
      ),
    );
    return;
  }

  const provided = req.header("x-internal-api-key");
  if (!provided || provided !== expected) {
    sendError(
      res,
      HTTP_STATUS.UNAUTHORIZED.withMessage("Invalid internal API key"),
    );
    return;
  }

  next();
};
