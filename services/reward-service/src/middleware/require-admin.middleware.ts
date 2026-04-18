import { Request, Response, NextFunction } from "express";
import { HTTP_STATUS, sendError } from "../constants/http-status";

export const requireAdmin = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const role = req.user?.role?.toLowerCase();
  if (!role || role !== "admin") {
    sendError(
      res,
      HTTP_STATUS.FORBIDDEN.withMessage("Admin access required"),
    );
    return;
  }
  next();
};
