import { Request, Response } from "express";
import { body, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import prisma from "../../config/prisma.client";
import { MediaResourceType } from "../../constants/status.enum";

function assertAdmin(req: Request, res: Response): boolean {
  const role = req.user?.role?.toLowerCase();
  if (!role || role !== "admin") {
    sendError(
      res,
      HTTP_STATUS.FORBIDDEN.withMessage("Only admin can register catalog media"),
    );
    return false;
  }
  return true;
}

/**
 * Register a hosted image URL as a `Media` row (e.g. gift catalog image after Cloudinary upload).
 * Admin only. Does not attach to a report.
 */
export const adminMediaController = {
  registerFromImageUrl: [
    body("imageUrl")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("imageUrl is required")
      .isURL()
      .withMessage("imageUrl must be a valid URL"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
        return;
      }

      if (!assertAdmin(req, res)) {
        return;
      }

      const userId = req.user?.userId;
      if (!userId) {
        sendError(res, HTTP_STATUS.UNAUTHORIZED);
        return;
      }

      const imageUrl = String(req.body.imageUrl).trim();

      try {
        const media = await prisma.media.create({
          data: {
            url: imageUrl,
            type: MediaResourceType.OTHER,
            createdBy: userId,
            updatedBy: userId,
          },
        });

        sendSuccess(res, HTTP_STATUS.CREATED, {
          media: {
            id: media.id,
            url: media.url,
            type: media.type,
          },
        });
      } catch (error) {
        console.error("Admin register media error:", error);
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ],
};
