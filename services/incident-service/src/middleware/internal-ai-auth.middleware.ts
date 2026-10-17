import { NextFunction, Request, Response } from "express";
import { HTTP_STATUS, sendError } from "../constants/http-status";

/**
 * Guards `/internal/v1/...` for service-to-service calls (ai-service).
 * Callers send the shared secret in `x-internal-api-key`.
 */
export const requireInternalAiApiKey = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const expected = process.env.INTERNAL_AI_API_KEY?.trim();
  if (!expected) {
    sendError(
      res,
      HTTP_STATUS.INTERNAL_SERVER_ERROR.withMessage(
        "INTERNAL_AI_API_KEY is not configured",
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
