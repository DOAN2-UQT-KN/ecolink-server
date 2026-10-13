import { Request, Response, NextFunction } from "express";
import { verifyToken, TokenPayload } from "../utils/jwt.utils";
import { HTTP_STATUS, sendError } from "../constants/http-status";

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

/**
 * Middleware to authenticate JWT token
 */
export const authenticate = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  try {
    // Get token from Authorization header or cookies
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.substring(7)
      : req.cookies?.accessToken;
    if (!token) {
      sendError(res, HTTP_STATUS.TOKEN_MISSING);
      return;
    }

    // Verify token
    const decoded = verifyToken(token.trim());

    // Attach user to request
    req.user = decoded;

    next();
  } catch (error) {
    sendError(res, HTTP_STATUS.TOKEN_INVALID);
  }
};

/**
 * Attaches `req.user` when a valid token is present and carries on regardless. For public
 * pages that behave slightly differently for a signed-in visitor.
 */
export const optionalAuthenticate = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.substring(7)
      : req.cookies?.accessToken;
    if (token) {
      req.user = verifyToken(token.trim());
    }
  } catch {
    // An expired or bad token on a public page just means "anonymous".
  }
  next();
};
