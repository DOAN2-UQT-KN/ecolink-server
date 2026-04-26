import { Request, Response } from "express";
import { body, param, query, validationResult } from "express-validator";
import { NotificationKind } from "@prisma/client";
import { HTTP_STATUS, sendError, sendSuccess } from "../../constants/http-status";
import { notificationService } from "./notification.service";
import { backgroundJobDispatcher } from "../../queue/register";
import {
  NotificationJobType,
  type SendNotificationJobPayload,
} from "../../queue/notification-job.types";
import type { NotificationItemData } from "./notification.dto";

const KIND_VALUES = Object.values(NotificationKind).filter(
  (v): v is NotificationKind => typeof v === "string",
);

function dtoFromRow(row: {
  id: string;
  userId: string | null;
  type: string;
  kind: string;
  title: string;
  body: string;
  payload: unknown;
  readAt: Date | null;
  createdAt: Date;
}): NotificationItemData {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type as NotificationItemData["type"],
    kind: row.kind as NotificationItemData["kind"],
    title: row.title,
    body: row.body,
    payload:
      typeof row.payload === "object" && row.payload !== null
        ? (row.payload as Record<string, unknown>)
        : {},
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const enqueueNotificationValidators = [
  body("type").isString().notEmpty(),
  body("kind").isString().isIn(KIND_VALUES),
  body("userId").optional().isUUID(),
  body("payload").optional().isObject(),
];

export const notificationController = {
  enqueue: async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }

    const { type, kind, userId, payload } = req.body as {
      type: string;
      kind: string;
      userId?: string;
      payload?: Record<string, string>;
    };

    try {
      const jobPayload: SendNotificationJobPayload = {
        type: type as "email" | "website",
        kind: kind as NotificationKind,
        userId,
        payload,
      };

      if (jobPayload.type === "website" && !jobPayload.userId) {
        sendError(
          res,
          HTTP_STATUS.BAD_REQUEST.withMessage(
            "userId is required for website notifications",
          ),
        );
        return;
      }

      if (jobPayload.type === "email") {
        const p = jobPayload.payload ?? {};
        const directTo =
          typeof p.toEmail === "string" ? p.toEmail.trim() : "";
        if (jobPayload.kind === NotificationKind.ORGANIZATION_CONTACT_VERIFY) {
          if (!directTo) {
            sendError(
              res,
              HTTP_STATUS.BAD_REQUEST.withMessage(
                "payload.toEmail is required for ORGANIZATION_CONTACT_VERIFY",
              ),
            );
            return;
          }
        } else if (!jobPayload.userId) {
          sendError(
            res,
            HTTP_STATUS.BAD_REQUEST.withMessage(
              "userId is required for email notifications",
            ),
          );
          return;
        }
      }

      await backgroundJobDispatcher.enqueue(
        NotificationJobType.SEND_NOTIFICATION,
        jobPayload,
      );
      sendSuccess(res, HTTP_STATUS.ACCEPTED, {
        accepted: true,
      });
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Failed to enqueue notification job";
      sendError(res, HTTP_STATUS.BAD_REQUEST.withMessage(msg));
    }
  },

  listMine: async (req: Request, res: Response): Promise<void> => {
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

    const unreadOnly = req.query.unreadOnly === "true" || req.query.unreadOnly === "1";
    const limitRaw = req.query.limit;
    const limit =
      typeof limitRaw === "string" ? Number.parseInt(limitRaw, 10) : undefined;

    const { items, unreadCount } = await notificationService.listForUser(
      userId,
      {
        unreadOnly,
        limit: Number.isFinite(limit) ? limit : undefined,
      },
    );

    sendSuccess(res, HTTP_STATUS.OK, {
      items: items.map(dtoFromRow),
      unreadCount,
    });
  },

  markRead: async (req: Request, res: Response): Promise<void> => {
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

    const { id } = req.params;
    const updated = await notificationService.markRead(userId, id);
    if (!updated) {
      sendError(res, HTTP_STATUS.NOT_FOUND);
      return;
    }

    sendSuccess(res, HTTP_STATUS.OK, dtoFromRow(updated));
  },
};

export const listMineValidators = [
  query("unreadOnly").optional().isIn(["true", "false", "0", "1"]),
  query("limit").optional().isInt({ min: 1, max: 200 }),
];

export const markReadValidators = [param("id").isUUID()];
