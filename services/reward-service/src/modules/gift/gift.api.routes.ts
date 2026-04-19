import { Router } from "express";
import { body, param, query, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { authenticate, tryAuthenticate } from "../../middleware/auth.middleware";
import { requireAdmin } from "../../middleware/require-admin.middleware";
import { giftService } from "./gift.service";

const router = Router();

/**
 * @route   GET /api/v1/gifts
 * @desc    List gifts with pagination and filters (non-admins only see active gifts; admins may filter `isActive` when authenticated)
 * @access  Public (optional Bearer for admin-only query flags)
 */
router.get(
  "/gifts",
  tryAuthenticate,
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("search").optional().isString().trim(),
  query("inStock")
    .optional()
    .isIn(["true", "false"])
    .withMessage('inStock must be "true" or "false"'),
  query("isActive")
    .optional()
    .isIn(["true", "false"])
    .withMessage('isActive must be "true" or "false"'),
  query("greenPointsMin").optional().isInt({ min: 0 }).toInt(),
  query("greenPointsMax").optional().isInt({ min: 0 }).toInt(),

  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
        errors: errors.array(),
      });
      return;
    }

    const page = (req.query.page as number | undefined) ?? 1;
    const limit = (req.query.limit as number | undefined) ?? 20;
    const search = req.query.search as string | undefined;
    const inStockRaw = req.query.inStock as string | undefined;
    const inStockOnly = inStockRaw === "true" ? true : undefined;
    const isActiveRaw = req.query.isActive as string | undefined;
    const greenPointsMin = req.query.greenPointsMin as number | undefined;
    const greenPointsMax = req.query.greenPointsMax as number | undefined;

    const role = req.user?.role?.toLowerCase();
    const isAdmin = role === "admin";

    let isActiveFilter: boolean | undefined;
    if (isAdmin && isActiveRaw !== undefined) {
      isActiveFilter = isActiveRaw === "true";
    }

    if (
      greenPointsMin !== undefined &&
      greenPointsMax !== undefined &&
      greenPointsMin > greenPointsMax
    ) {
      sendError(
        res,
        HTTP_STATUS.VALIDATION_ERROR.withMessage(
          "greenPointsMin must be <= greenPointsMax",
        ),
      );
      return;
    }

    try {
      const { gifts, total } = await giftService.listGifts({
        page,
        limit,
        search,
        inStockOnly,
        isActive: isActiveFilter,
        greenPointsMin,
        greenPointsMax,
        isAdmin,
      });

      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

      sendSuccess(res, HTTP_STATUS.OK, {
        gifts,
        meta: { page, limit, total, totalPages },
      });
    } catch (error) {
      console.error("List gifts error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

/**
 * @route   GET /api/v1/gifts/me/green-points
 * @desc    Current user's green point balance (0 if no row yet)
 * @access  Private
 */
router.get("/gifts/me/green-points", authenticate, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) {
    sendError(res, HTTP_STATUS.UNAUTHORIZED);
    return;
  }

  try {
    const balance = await giftService.getGreenPointBalance(userId);
    sendSuccess(res, HTTP_STATUS.OK, { balance });
  } catch (error) {
    console.error("Get green points balance error:", error);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

/**
 * @route   GET /api/v1/gifts/me/redemptions
 * @desc    Paginated gift redemptions for the authenticated user
 * @access  Private
 */
router.get(
  "/gifts/me/redemptions",
  authenticate,
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),

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

    try {
      const { redemptions, total } = await giftService.listRedemptionsForUser(
        userId,
        page,
        limit,
      );
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      sendSuccess(res, HTTP_STATUS.OK, {
        redemptions,
        meta: { page, limit, total, totalPages },
      });
    } catch (error) {
      console.error("List my gift redemptions error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

/**
 * @route   POST /api/v1/gifts
 * @desc    Create a gift
 * @access  Private (Admin)
 */
router.post(
  "/gifts",
  authenticate,
  requireAdmin,
  body("name").trim().isLength({ min: 1, max: 255 }),
  body("mediaId").isUUID().withMessage("mediaId must be a UUID"),
  body("description").isString().trim(),
  body("greenPoints")
    .isInt({ min: 0 })
    .withMessage("greenPoints must be an integer >= 0"),
  body("stockRemaining")
    .optional({ values: "null" })
    .custom((v) => v === null || (Number.isInteger(v) && v >= 0))
    .withMessage("stockRemaining must be null or an integer >= 0"),
  body("isActive").optional().isBoolean(),

  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
        errors: errors.array(),
      });
      return;
    }

    try {
      const gift = await giftService.create({
        name: req.body.name,
        mediaId: req.body.mediaId,
        description: req.body.description,
        greenPoints: req.body.greenPoints,
        stockRemaining: req.body.stockRemaining,
        isActive: req.body.isActive,
      });
      sendSuccess(res, HTTP_STATUS.CREATED, { gift });
    } catch (error) {
      console.error("Create gift error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

/**
 * @route   PUT /api/v1/gifts/:id
 * @desc    Update a gift
 * @access  Private (Admin)
 */
router.put(
  "/gifts/:id",
  authenticate,
  requireAdmin,
  param("id").isUUID().withMessage("id must be a UUID"),
  body("name").optional().trim().isLength({ min: 1, max: 255 }),
  body("mediaId").optional().isUUID().withMessage("mediaId must be a UUID"),
  body("description").optional().isString().trim(),
  body("greenPoints")
    .optional()
    .isInt({ min: 0 })
    .withMessage("greenPoints must be an integer >= 0"),
  body("stockRemaining")
    .optional({ values: "null" })
    .custom((v) => v === null || (Number.isInteger(v) && v >= 0))
    .withMessage("stockRemaining must be null or an integer >= 0"),
  body("isActive").optional().isBoolean(),

  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
        errors: errors.array(),
      });
      return;
    }

    try {
      const id = req.params?.id;
      if (!id) {
        sendError(res, HTTP_STATUS.BAD_REQUEST.withMessage("Missing id"));
        return;
      }
      const updated = await giftService.updateById(id, {
        name: req.body.name,
        mediaId: req.body.mediaId,
        description: req.body.description,
        greenPoints: req.body.greenPoints,
        stockRemaining: req.body.stockRemaining,
        isActive: req.body.isActive,
      });
      if (!updated) {
        sendError(res, HTTP_STATUS.NOT_FOUND);
        return;
      }
      sendSuccess(res, HTTP_STATUS.OK, { gift: updated });
    } catch (error) {
      console.error("Update gift error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

/**
 * @route   POST /api/v1/gifts/:id/redeem
 * @desc    Redeem a gift for the authenticated user (deducts green points when cost > 0)
 * @access  Private
 */
router.post(
  "/gifts/:id/redeem",
  authenticate,
  param("id").isUUID().withMessage("id must be a UUID"),

  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
        errors: errors.array(),
      });
      return;
    }

    const id = req.params?.id;
    const userId = req.user?.userId;
    if (!id || !userId) {
      sendError(res, HTTP_STATUS.BAD_REQUEST.withMessage("Missing id or user"));
      return;
    }

    try {
      const redemption = await giftService.redeem(userId, id);
      sendSuccess(res, HTTP_STATUS.OK, { redemption });
    } catch (error) {
      if (sendHttpErrorResponse(res, error)) {
        return;
      }
      console.error("Redeem gift error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

export default router;
