import { Router, type Request, type Response } from "express";
import { body, param, query, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { authenticate } from "../../middleware/auth.middleware";
import { userPointsService } from "./user-points.service";
import { giftService } from "../gift/gift.service";

const router = Router();

/**
 * @route   GET /api/v1/me/points
 * @desc    Green point balance, points expiring within 7 days, and total earned
 * @access  Private
 */
router.get("/me/points", authenticate, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) {
    sendError(res, HTTP_STATUS.UNAUTHORIZED);
    return;
  }

  try {
    const data = await userPointsService.getPoints(userId);
    sendSuccess(res, HTTP_STATUS.OK, data);
  } catch (error) {
    console.error("Get me points error:", error);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

/**
 * @route   GET /api/v1/me/points/transactions
 * @desc    List points transactions with pagination
 * @access  Private
 */
router.get(
  "/me/points/transactions",
  authenticate,
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("type").optional().isString().trim(),
  query("sortBy").optional().isIn(["createdAt", "points", "type"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
        errors: errors.array(),
      });
      return;
    }

    const userId = req.user?.userId;
    if (!userId) {
      sendError(res, HTTP_STATUS.UNAUTHORIZED);
      return;
    }

    const page = (req.query.page as number | undefined) ?? 1;
    const limit = (req.query.limit as number | undefined) ?? 20;
    const type = req.query.type as string | undefined;
    const sortBy = (req.query.sortBy as string | undefined) ?? "createdAt";
    const sortOrder = (req.query.sortOrder as string | undefined) ?? "desc";

    try {
      const { transactions, total } = await userPointsService.getTransactions(
        userId,
        page,
        limit,
        type,
        sortBy,
        sortOrder,
        req.headers.authorization
      );

      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      sendSuccess(res, HTTP_STATUS.OK, {
        transactions,
        page,
        limit,
        total,
        totalPages,
      });
    } catch (error) {
      console.error("Get transactions error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
);

/**
 * @route   GET /api/v1/me/redemptions
 * @desc    Get redemption history
 * @access  Private
 */
router.get(
  "/me/redemptions",
  authenticate,
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("code").optional().isString().isLength({ max: 20 }),
  query("sortBy").optional().isIn(["createdAt", "greenPointsSpent", "statusUpdatedAt"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
        errors: errors.array(),
      });
      return;
    }

    const userId = req.user?.userId;
    if (!userId) {
      sendError(res, HTTP_STATUS.UNAUTHORIZED);
      return;
    }

    const page = (req.query.page as number | undefined) ?? 1;
    const limit = (req.query.limit as number | undefined) ?? 20;
    const sortBy =
      (req.query.sortBy as "createdAt" | "greenPointsSpent" | "statusUpdatedAt" | undefined) ??
      "createdAt";
    const sortOrder = (req.query.sortOrder as "asc" | "desc" | undefined) ?? "desc";

    try {
      const { redemptions, total } = await giftService.listRedemptionsForUser(userId, {
        page,
        limit,
        code: req.query.code as string | undefined,
        sortBy,
        sortOrder,
      });
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      sendSuccess(res, HTTP_STATUS.OK, {
        redemptions,
        page,
        limit,
        total,
        totalPages,
      });
    } catch (error) {
      console.error("Get redemptions error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
);

const ORDER_NOT_FOUND = HTTP_STATUS.NOT_FOUND.withMessage("Redemption not found");

/**
 * @route   GET /api/v1/me/redemptions/:code
 * @desc    One of my orders by order code, with its history (no admin identities)
 * @access  Private (owner only; anyone else gets 404)
 */
router.get(
  "/me/redemptions/:code",
  authenticate,
  param("code").isString().isLength({ max: 20 }),
  async (req, res): Promise<void> => {
    const userId = req.user?.userId;
    if (!userId) {
      sendError(res, HTTP_STATUS.UNAUTHORIZED);
      return;
    }
    try {
      const redemption = validationResult(req).isEmpty()
        ? await giftService.getMyRedemptionByCode(userId, req.params.code)
        : null;
      if (!redemption) {
        sendError(res, ORDER_NOT_FOUND);
        return;
      }
      sendSuccess(res, HTTP_STATUS.OK, { redemption });
    } catch (error) {
      console.error("Get my redemption error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

/** Shared tail of the owner's order actions: 400 / 404 / service errors / 200 with the detail. */
async function runOwnerAction(
  req: Request,
  res: Response,
  action: (userId: string, code: string) => Promise<unknown>,
  label: string,
): Promise<void> {
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
  try {
    if (!(await action(userId, req.params.code))) {
      sendError(res, ORDER_NOT_FOUND);
      return;
    }
    const redemption = await giftService.getMyRedemptionByCode(userId, req.params.code);
    sendSuccess(res, HTTP_STATUS.OK, { redemption });
  } catch (error) {
    if (sendHttpErrorResponse(res, error)) {
      return;
    }
    console.error(`${label} error:`, error);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * @route   POST /api/v1/me/redemptions/:code/cancel
 * @desc    Cancel my order while it is still PROCESSING; points refunded, item back to stock
 * @access  Private (owner only)
 */
router.post(
  "/me/redemptions/:code/cancel",
  authenticate,
  body("cancelReason")
    .isString()
    .withMessage("Cancel reason must be 1 to 500 characters")
    .bail()
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage("Cancel reason must be 1 to 500 characters"),
  (req, res) =>
    runOwnerAction(
      req,
      res,
      (userId, code) => giftService.cancelMyRedemption(userId, code, req.body.cancelReason),
      "Cancel my redemption",
    ),
);

/**
 * @route   POST /api/v1/me/redemptions/:code/confirm-delivery
 * @desc    Confirm my SHIPPED order arrived (moves it to DELIVERED)
 * @access  Private (owner only)
 */
router.post(
  "/me/redemptions/:code/confirm-delivery",
  authenticate,
  (req, res) =>
    runOwnerAction(
      req,
      res,
      (userId, code) => giftService.confirmMyRedemption(userId, code),
      "Confirm my redemption",
    ),
);

export default router;
