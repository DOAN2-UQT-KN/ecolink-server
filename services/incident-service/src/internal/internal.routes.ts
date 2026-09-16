import { Router } from "express";
import { body, param, validationResult } from "express-validator";
import type { Prisma } from "@prisma/client";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../constants/http-status";
import { requireInternalAiApiKey } from "../middleware/internal-ai-auth.middleware";
import { reportService } from "../modules/report/report.service";
import { toDuplicateVerification } from "../modules/report/report.entity";
import type { DuplicateVerificationGroup } from "../modules/report/report.dto";

const router = Router();

router.use(requireInternalAiApiKey);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function stringField(
  obj: Record<string, unknown>,
  camel: string,
  snake: string,
): string | null {
  const raw = obj[camel] ?? obj[snake];
  return typeof raw === "string" && raw ? raw : null;
}

/**
 * New workers send a JSON array. A process that has not reloaded still sends
 * the legacy object; `toDuplicateVerification` groups that on write.
 */
function validateDuplicateVerificationBody(body: unknown): string | null {
  if (isRecord(body)) {
    return null;
  }
  if (!Array.isArray(body)) {
    return "duplicate_verification must be an array";
  }
  for (const item of body) {
    if (!isRecord(item) || !stringField(item, "duplicateReportId", "duplicate_report_id")) {
      return "duplicate_report_id is required";
    }
    if (!Array.isArray(item.matches)) {
      return "matches must be an array";
    }
    for (const match of item.matches) {
      if (!isRecord(match) || !stringField(match, "mediaId", "media_id")) {
        return "matches.media_id is required";
      }
      if (!stringField(match, "duplicateMediaId", "duplicate_media_id")) {
        return "matches.duplicate_media_id is required";
      }
    }
  }
  return null;
}

function parseDuplicateVerificationBody(
  body: unknown,
): DuplicateVerificationGroup[] {
  const parsed = toDuplicateVerification(body as Prisma.JsonValue);
  return parsed ?? [];
}

router.patch(
  "/reports/:id/duplicate-verification",
  param("id").isUUID().withMessage("Report ID must be a valid UUID"),
  body().custom((value) => {
    const message = validateDuplicateVerificationBody(value);
    if (message) {
      throw new Error(message);
    }
    return true;
  }),

  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
        errors: errors.array(),
      });
      return;
    }

    try {
      const reportId = req.params?.id;
      if (!reportId) {
        sendError(res, HTTP_STATUS.BAD_REQUEST.withMessage("Missing report id"));
        return;
      }
      await reportService.saveDuplicateVerification(
        reportId,
        parseDuplicateVerificationBody(req.body),
      );
      sendSuccess(res, HTTP_STATUS.OK);
    } catch (error) {
      if (sendHttpErrorResponse(res, error)) {
        return;
      }
      console.error("Save duplicate verification error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

router.post(
  "/reports/inactive-ids",
  body("reportIds")
    .isArray()
    .withMessage("report_ids must be an array"),
  body("reportIds.*")
    .isUUID()
    .withMessage("report_ids items must be UUIDs"),

  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
        errors: errors.array(),
      });
      return;
    }

    try {
      const reportIds = (req.body as { reportIds?: string[] }).reportIds ?? [];
      const inactiveIds = await reportService.findInactiveReportIds(reportIds);
      sendSuccess(res, HTTP_STATUS.OK, { reportIds: inactiveIds });
    } catch (error) {
      if (sendHttpErrorResponse(res, error)) {
        return;
      }
      console.error("Inactive report ids lookup error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

export default router;
