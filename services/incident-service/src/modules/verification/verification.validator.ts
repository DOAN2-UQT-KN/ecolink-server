import { body, query } from "express-validator";
import { ModerationReasonCode } from "@prisma/client";
import { reportIdParamValidator } from "../report/report.validator";

export const moderationQueueValidators = [
  query("flag").optional().isIn(["REVIEW", "REJECT"]).withMessage("flag must be REVIEW or REJECT"),
  query("page").optional().isInt({ min: 1 }).withMessage("page must be >= 1"),
  query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("limit must be between 1 and 100"),
];

export const moderateValidators = [
  ...reportIdParamValidator,
  body("decision").isIn(["ACCEPT", "REJECT"]).withMessage("decision must be ACCEPT or REJECT"),
  body("reasonCode")
    .if(body("decision").equals("REJECT"))
    .isIn(Object.values(ModerationReasonCode))
    .withMessage("reason_code is required when rejecting"),
  body("note").optional().isString().trim().isLength({ max: 5000 }).withMessage("note must be at most 5000 characters"),
];
