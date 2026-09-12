import { Router } from "express";
import { body, param, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../constants/http-status";
import { requireInternalAiApiKey } from "../middleware/internal-ai-auth.middleware";
import { reportService } from "../modules/report/report.service";
import type {
  DuplicateMediaMatch,
  DuplicateVerification,
} from "../modules/report/report.dto";

const router = Router();

router.use(requireInternalAiApiKey);

function parseDuplicateVerificationBody(
  body: Record<string, unknown>,
): DuplicateVerification {
  const duplicateReportIdRaw = body.duplicateReportId;
  const duplicateReportId =
    typeof duplicateReportIdRaw === "string" && duplicateReportIdRaw
      ? duplicateReportIdRaw
      : null;

  const reasonsRaw = body.reasons;
  const reasons = Array.isArray(reasonsRaw)
    ? reasonsRaw.filter((item): item is string => typeof item === "string")
    : [];

  const matches: DuplicateMediaMatch[] = [];
  const matchesRaw = body.matches;
  if (Array.isArray(matchesRaw)) {
    for (const item of matchesRaw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const match = item as Record<string, unknown>;
      const mediaId = match.mediaId;
      const duplicateMediaId = match.duplicateMediaId;
      if (typeof mediaId === "string" && typeof duplicateMediaId === "string") {
        matches.push({ mediaId, duplicateMediaId });
      }
    }
  }

  return { duplicateReportId, reasons, matches };
}

router.patch(
  "/reports/:id/duplicate-verification",
  param("id").isUUID().withMessage("Report ID must be a valid UUID"),
  body("duplicateReportId")
    .optional({ nullable: true })
    .custom((value) => value === null || typeof value === "string")
    .withMessage("duplicate_report_id must be a string or null"),
  body("reasons").optional().isArray().withMessage("reasons must be an array"),
  body("reasons.*").optional().isString(),
  body("matches").optional().isArray().withMessage("matches must be an array"),
  body("matches.*.mediaId")
    .isString()
    .notEmpty()
    .withMessage("matches.media_id is required"),
  body("matches.*.duplicateMediaId")
    .isString()
    .notEmpty()
    .withMessage("matches.duplicate_media_id is required"),

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
