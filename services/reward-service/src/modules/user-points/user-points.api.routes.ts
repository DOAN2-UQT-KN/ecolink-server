import { Router } from "express";
import { query, validationResult } from "express-validator";
import { HTTP_STATUS, sendError, sendSuccess } from "../../constants/http-status";
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
      const { redemptions, total } = await giftService.listRedemptionsForUser(
        userId,
        page,
        limit,
        sortBy,
        sortOrder
      );
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

export default router;
