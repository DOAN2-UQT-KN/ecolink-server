import {
  FACEBOOK_RECOGNITION_JOB_TYPE,
  type CampaignFacebookRecognitionPayload,
} from "../modules/facebook-recognition/facebook-recognition.types";
import { facebookRecognitionService } from "../modules/facebook-recognition/facebook-recognition.service";
import { Router } from "express";
import { body, param, validationResult } from "express-validator";
import { HTTP_STATUS, sendError, sendSuccess } from "../constants/http-status";
import { requireInternalRewardApiKey } from "../middleware/internal-reward-auth.middleware";
import { difficultyService } from "../modules/difficulty/difficulty.service";
import { greenPointService } from "../modules/green-point/green-point.instances";
import { KNOWN_GREEN_POINT_JOB_TYPES } from "../modules/green-point/green-point.types";

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

/**
 * POST body: { type: KnownGreenPointJobType, payload: object }
 * `type` selects the strategy (same string as SQS `jobType`); `payload` is validated by that strategy.
 */
router.post(
  "/green-points/enqueue",
  body("type")
    .isString()
    .trim()
    .isIn([...KNOWN_GREEN_POINT_JOB_TYPES])
    .withMessage(`type must be one of: ${KNOWN_GREEN_POINT_JOB_TYPES.join(", ")}`),
  body("payload")
    .exists()
    .withMessage("payload is required")
    .bail()
    .custom((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("payload must be a plain object");
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

    const { type, payload } = req.body as {
      type: string;
      payload: Record<string, unknown>;
    };

    try {
      await greenPointService.enqueue(type, payload);
      sendSuccess(res, HTTP_STATUS.ACCEPTED, {
        queued: true,
        type,
      });
    } catch (error) {
      console.error("Enqueue green points error:", error);
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("SQS_GREEN_POINT_QUEUE_URL")) {
        sendError(
          res,
          HTTP_STATUS.INTERNAL_SERVER_ERROR.withMessage(
            "Green point queue is not configured",
          ),
        );
        return;
      }

      // Strategy `validatePayload` / enqueue guards (client payload mistakes)
      if (
        /required|must be|not an array|Each credit/i.test(message)
      ) {
        sendError(res, HTTP_STATUS.BAD_REQUEST.withMessage(message));
        return;
      }

      sendError(
        res,
        HTTP_STATUS.INTERNAL_SERVER_ERROR.withMessage(message),
      );
    }
  },
);

/**
 * POST body: { payload: CampaignFacebookRecognitionPayload }
 * Queues recognition message for Facebook posting worker.
 */
router.post(
  "/facebook-recognition/enqueue",
  body("payload")
    .exists()
    .withMessage("payload is required")
    .bail()
    .custom((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("payload must be a plain object");
      }
      return true;
    }),
  body("payload.campaignId")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("payload.campaignId is required"),
  body("payload.campaignTitle")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("payload.campaignTitle is required"),
  body("payload.recognizedUserIds")
    .isArray()
    .withMessage("payload.recognizedUserIds must be an array"),
  body("payload.completedAt")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("payload.completedAt is required"),
  body("payload.bannerUrl")
    .optional({ values: "null" })
    .isString()
    .isLength({ max: 2048 })
    .withMessage("payload.bannerUrl must be a string at most 2048 chars"),
  body("payload.description")
    .optional({ values: "null" })
    .isString()
    .withMessage("payload.description must be a string when provided"),
  body("payload.recognizedVolunteers")
    .optional({ values: "null" })
    .isArray()
    .withMessage("payload.recognizedVolunteers must be an array when provided"),
  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
        errors: errors.array(),
      });
      return;
    }

    const payload = req.body.payload as CampaignFacebookRecognitionPayload;
    try {
      await facebookRecognitionService.enqueue(payload);
      sendSuccess(res, HTTP_STATUS.ACCEPTED, {
        queued: true,
        type: FACEBOOK_RECOGNITION_JOB_TYPE,
      });
    } catch (error) {
      console.error("Enqueue facebook recognition error:", error);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("SQS_FACEBOOK_RECOGNITION_QUEUE_URL")) {
        sendError(
          res,
          HTTP_STATUS.INTERNAL_SERVER_ERROR.withMessage(
            "Facebook recognition queue is not configured",
          ),
        );
        return;
      }
      if (/required|must be|array/i.test(message)) {
        sendError(res, HTTP_STATUS.BAD_REQUEST.withMessage(message));
        return;
      }
      sendError(
        res,
        HTTP_STATUS.INTERNAL_SERVER_ERROR.withMessage(message),
      );
    }
  },
);

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

export default router;
