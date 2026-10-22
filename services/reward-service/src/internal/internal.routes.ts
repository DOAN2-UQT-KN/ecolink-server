import { Router } from "express";
import { param, validationResult } from "express-validator";
import { HTTP_STATUS, sendError, sendSuccess } from "../constants/http-status";
import { requireInternalRewardApiKey } from "../middleware/internal-reward-auth.middleware";
import { difficultyService } from "../modules/difficulty/difficulty.service";
import { loadActivePointRules } from "../modules/gamification/gamification-config.service";
import prisma from "../config/prisma.client";

const router = Router();

router.use(requireInternalRewardApiKey);

router.get("/difficulties", async (_req, res): Promise<void> => {
  try {
    const difficulties = await difficultyService.listActive();
    sendSuccess(res, HTTP_STATUS.OK, { difficulties });
  } catch (error) {
    console.error("List difficulties error:", error);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// Green-point credit and Facebook recognition events are no longer accepted over
// HTTP. Producers (incident-service) publish them via their transactional outbox
// onto the shared reward intake SQS queue, consumed by RewardIntakeWorker.

router.get(
  "/difficulties/level/:level",
  param("level").isInt({ min: 1 }).withMessage("level must be a positive integer"),

  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
        errors: errors.array(),
      });
      return;
    }

    try {
      const levelStr = req.params?.level;
      if (!levelStr) {
        sendError(
          res,
          HTTP_STATUS.BAD_REQUEST.withMessage("Missing level"),
        );
        return;
      }
      const level = parseInt(levelStr, 10);
      const difficulty = await difficultyService.findByLevel(level);
      if (!difficulty) {
        sendError(
          res,
          HTTP_STATUS.NOT_FOUND.withMessage("Difficulty not found"),
        );
        return;
      }
      sendSuccess(res, HTTP_STATUS.OK, { difficulty });
    } catch (error) {
      console.error("Get difficulty by level error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

/** Campaign completion points for incident-service to show on campaigns (spec 013 FR-040). */
router.get("/point-rules/campaign-completion", async (_req, res): Promise<void> => {
  try {
    const rules = await loadActivePointRules(prisma);
    if (!rules) {
      sendError(res, HTTP_STATUS.NOT_FOUND.withMessage("No active point rules"));
      return;
    }
    sendSuccess(res, HTTP_STATUS.OK, {
      campaignCompletionPoints: rules.campaignCompletionPoints,
    });
  } catch (error) {
    console.error("Get campaign completion points error:", error);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
