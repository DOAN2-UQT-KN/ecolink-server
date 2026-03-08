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
    const decoded = verifyToken(token);

    // Attach user to request
    req.user = decoded;

    next();
  } catch (error) {
    sendError(res, HTTP_STATUS.TOKEN_INVALID);
  }
};
