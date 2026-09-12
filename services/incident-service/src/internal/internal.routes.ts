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
import type { DuplicateVerification } from "../modules/report/report.dto";

const router = Router();

router.use(requireInternalAiApiKey);

function parseDuplicateVerificationBody(
  body: Record<string, unknown>,
): DuplicateVerification {
  const parsed = toDuplicateVerification(body as Prisma.JsonValue);
  if (parsed != null) {
    return parsed;
  }
  return { duplicateReportId: null, reason: null, matches: [] };
}

router.patch(
  "/reports/:id/duplicate-verification",
  param("id").isUUID().withMessage("Report ID must be a valid UUID"),
  body("duplicateReportId")
    .optional({ nullable: true })
    .custom((value) => value === null || typeof value === "string")
    .withMessage("duplicate_report_id must be a string or null"),
  body("reason")
    .optional({ nullable: true })
    .custom((value) => value === null || typeof value === "string")
    .withMessage("reason must be a string or null"),
  // Legacy AI payloads sent detect codes as `reasons: string[]`.
  body("reasons").optional().isArray().withMessage("reasons must be an array"),
  body("reasons.*").optional().isString(),
  body("matches").optional().isArray().withMessage("matches must be an array"),
  body("matches.*.mediaId")
    .optional()
    .isString()
    .notEmpty()
    .withMessage("matches.media_id is required"),
  body("matches.*.duplicateMediaId")
    .optional()
    .isString()
    .notEmpty()
    .withMessage("matches.duplicate_media_id is required"),
  body("matches.*.reason")
    .optional({ nullable: true })
    .isString()
    .withMessage("matches.reason must be a string"),

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
        parseDuplicateVerificationBody(req.body as Record<string, unknown>),
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

export default router;
