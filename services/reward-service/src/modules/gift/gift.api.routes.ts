import { Router, type Request, type Response } from "express";
import { body, param, query, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import {
  authenticate,
  tryAuthenticate,
} from "../../middleware/auth.middleware";
import { requireAdmin } from "../../middleware/require-admin.middleware";
import { enqueueGiftOrderShippedNotification } from "../../utils/notification.client";
import { MAX_REDEEM_QUANTITY } from "./gift.dto";
import { giftService } from "./gift.service";

const router = Router();
const GIFT_REDEMPTION_STATUSES = [
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
] as const;

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
  query("sortBy").optional().isIn(["createdAt", "name", "greenPoints"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),

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
    const sortBy = req.query.sortBy as
      | "createdAt"
      | "name"
      | "greenPoints"
      | undefined;
    const sortOrder = req.query.sortOrder as "asc" | "desc" | undefined;

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
        sortBy,
        sortOrder,
      });

      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

      sendSuccess(res, HTTP_STATUS.OK, {
        gifts,
        page,
        limit,
        total,
        totalPages,
      });
    } catch (error) {
      console.error("List gifts error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

/**
 * @route   GET /api/v1/gifts/:id
 * @desc    Get gift details by id
 * @access  Public
 */
router.get(
  "/gifts/:id",
  tryAuthenticate,
  param("id").isUUID("loose").withMessage("id must be a valid UUID"),
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
      const isAdmin = req.user?.role?.toLowerCase() === "admin";
      const gift = await giftService.getGiftById(id, isAdmin);
      if (!gift) {
        sendError(res, HTTP_STATUS.NOT_FOUND.withMessage("Gift not found"));
        return;
      }
      sendSuccess(res, HTTP_STATUS.OK, { gift });
    } catch (error) {
      console.error("Get gift error:", error);
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
  body("nameVi").optional().trim().isLength({ min: 1, max: 255 }),
  body("nameEn").optional().trim().isLength({ min: 1, max: 255 }),
  body("imageUrl").optional().isURL().withMessage("imageUrl must be a valid URL"),
  body("description").isString().trim(),
  body("descriptionVi").optional().isString().trim(),
  body("descriptionEn").optional().isString().trim(),
  body("greenPoints")
    .isInt({ min: 0 })
    .withMessage("greenPoints must be an integer >= 0"),
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
        nameVi: req.body.nameVi,
        nameEn: req.body.nameEn,
        imageUrl: req.body.imageUrl,
        description: req.body.description,
        descriptionVi: req.body.descriptionVi,
        descriptionEn: req.body.descriptionEn,
        greenPoints: req.body.greenPoints,
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
  param("id").isUUID("loose").withMessage("id must be a UUID"),
  body("name").optional().trim().isLength({ min: 1, max: 255 }),
  body("nameVi").optional().trim().isLength({ min: 1, max: 255 }),
  body("nameEn").optional().trim().isLength({ min: 1, max: 255 }),
  body("imageUrl").optional().isURL().withMessage("imageUrl must be a valid URL"),
  body("description").optional().isString().trim(),
  body("descriptionVi").optional().isString().trim(),
  body("descriptionEn").optional().isString().trim(),
  body("greenPoints")
    .optional()
    .isInt({ min: 0 })
    .withMessage("greenPoints must be an integer >= 0"),
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
        nameVi: req.body.nameVi,
        nameEn: req.body.nameEn,
        imageUrl: req.body.imageUrl,
        description: req.body.description,
        descriptionVi: req.body.descriptionVi,
        descriptionEn: req.body.descriptionEn,
        greenPoints: req.body.greenPoints,
        isActive: req.body.isActive,
      }, req.headers.authorization);
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

async function handleGiftRedeem(
  req: Request,
  res: Response,
): Promise<void> {
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
    const redemption = await giftService.redeem(userId, id, {
      quantity: req.body.quantity ?? 1,
      phoneNumber: req.body.phoneNumber,
      recipientName: req.body.recipientName,
      pickupLocation: req.body.pickupLocation,
      addressDetail: req.body.addressDetail,
      deliveryLatitude: req.body.deliveryLatitude,
      deliveryLongitude: req.body.deliveryLongitude,
      deliveryNote: req.body.deliveryNote,
    });
    sendSuccess(res, HTTP_STATUS.OK, { redemption });
  } catch (error) {
    if (sendHttpErrorResponse(res, error)) {
      return;
    }
    console.error("Gift redeem error:", error);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * @route   GET /api/v1/admin/gift-redemptions
 * @desc    List gift redemption orders for admin management
 * @access  Private (Admin)
 */
router.get(
  "/admin/gift-redemptions",
  authenticate,
  requireAdmin,
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("status").optional().isIn(GIFT_REDEMPTION_STATUSES),
  query("sourceId").optional().isUUID("loose"),
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

    const page = (req.query.page as number | undefined) ?? 1;
    const limit = (req.query.limit as number | undefined) ?? 20;
    const status = req.query.status as (typeof GIFT_REDEMPTION_STATUSES)[number] | undefined;
    const sortBy =
      (req.query.sortBy as "createdAt" | "greenPointsSpent" | "statusUpdatedAt" | undefined) ??
      "createdAt";
    const sortOrder = (req.query.sortOrder as "asc" | "desc" | undefined) ?? "desc";

    try {
      const { redemptions, total } = await giftService.listRedemptionsForAdmin({
        page,
        limit,
        status,
        code: req.query.code as string | undefined,
        sourceId: req.query.sourceId as string | undefined,
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
      console.error("List admin gift redemptions error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

/**
 * @route   PATCH /api/v1/admin/gift-redemptions/:id/status
 * @desc    Update order status; cancelling needs cancelReason, and restock when the order was SHIPPED
 * @access  Private (Admin)
 */
router.patch(
  "/admin/gift-redemptions/:id/status",
  authenticate,
  requireAdmin,
  param("id").isUUID("loose").withMessage("id must be a UUID"),
  body("status").isIn(GIFT_REDEMPTION_STATUSES),
  body("cancelReason").optional().isString(),
  body("restock").optional().isBoolean(),
  // Required when shipping; checked in the service so the error names the field either way.
  body("carrier").optional().isString(),
  body("trackingCode").optional().isString(),
  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
        errors: errors.array(),
      });
      return;
    }

    try {
      const result = await giftService.updateRedemptionStatus(
        req.params.id,
        {
          status: req.body.status,
          cancelReason: req.body.cancelReason,
          restock: req.body.restock,
          carrier: req.body.carrier,
          trackingCode: req.body.trackingCode,
        },
        req.user?.userId ?? null,
      );
      if (!result) {
        sendError(res, HTTP_STATUS.NOT_FOUND.withMessage("Redemption not found"));
        return;
      }
      const { redemption } = result;
      if (result.changed && redemption.status === "SHIPPED") {
        void notifyShipped(redemption.id);
      }
      sendSuccess(res, HTTP_STATUS.OK, { redemption });
    } catch (error) {
      if (sendHttpErrorResponse(res, error)) {
        return;
      }
      console.error("Update gift redemption status error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

/** After the commit; a failed notification never undoes the shipment (spec 017 R7). */
async function notifyShipped(redemptionId: string): Promise<void> {
  try {
    const order = await giftService.getShippedNotificationData(redemptionId);
    if (order) await enqueueGiftOrderShippedNotification(order);
  } catch (error) {
    console.error("Gift shipped notification failed:", error);
  }
}

/**
 * @route   PATCH /api/v1/admin/gift-redemptions/:id/tracking
 * @desc    Correct the carrier / tracking code of a SHIPPED order; logged in the order history
 * @access  Private (Admin)
 */
router.patch(
  "/admin/gift-redemptions/:id/tracking",
  authenticate,
  requireAdmin,
  param("id").isUUID("loose").withMessage("id must be a UUID"),
  body("carrier")
    .isString()
    .bail()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage("Carrier is required (at most 100 characters)"),
  body("trackingCode")
    .isString()
    .bail()
    .trim()
    .matches(/^[A-Za-z0-9._/-]{1,100}$/)
    .withMessage("Tracking code is required: 1–100 letters, digits or . _ / -"),
  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    try {
      const redemption = await giftService.updateTracking(
        req.params.id,
        { carrier: req.body.carrier, trackingCode: req.body.trackingCode },
        req.user?.userId ?? null,
      );
      if (!redemption) {
        sendError(res, HTTP_STATUS.NOT_FOUND.withMessage("Redemption not found"));
        return;
      }
      sendSuccess(res, HTTP_STATUS.OK, { redemption });
    } catch (error) {
      if (sendHttpErrorResponse(res, error)) {
        return;
      }
      console.error("Update gift redemption tracking error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

/**
 * @route   GET /api/v1/admin/gift-redemptions/:code
 * @desc    One order by its order code, with gift, account, source and full history
 * @access  Private (Admin)
 */
router.get(
  "/admin/gift-redemptions/:code",
  authenticate,
  requireAdmin,
  param("code").isString().isLength({ max: 20 }),
  async (req, res): Promise<void> => {
    try {
      const redemption = validationResult(req).isEmpty()
        ? await giftService.getAdminRedemptionByCode(req.params.code)
        : null;
      if (!redemption) {
        sendError(res, HTTP_STATUS.NOT_FOUND.withMessage("Redemption not found"));
        return;
      }
      sendSuccess(res, HTTP_STATUS.OK, { redemption });
    } catch (error) {
      console.error("Get admin gift redemption error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

/**
 * @route   POST /api/v1/gifts/:id/redeem
 * @desc    Redeem 1..10 items of a gift at its listed price; points taken from green-point lots, earliest expiry first
 * @access  Private
 */
router.post(
  "/gifts/:id/redeem",
  authenticate,
  param("id").isUUID("loose").withMessage("id must be a UUID"),
  // Absent on older clients (mobile), which order one item.
  body("quantity")
    .optional({ values: "null" })
    .isInt({ min: 1, max: MAX_REDEEM_QUANTITY })
    .withMessage(`Quantity must be a whole number from 1 to ${MAX_REDEEM_QUANTITY}`)
    .toInt(),
  // Shown to users as XXXX XXX XXX; stored as digits only.
  body("phoneNumber")
    .isString()
    .customSanitizer((v: string) => v.replace(/[\s.\-()]/g, ""))
    .matches(/^(0\d{9}|\+84\d{9})$/)
    .withMessage("phoneNumber must be a Vietnamese mobile number (10 digits starting with 0)"),
  body("recipientName")
    .isString()
    .withMessage("recipientName is required (at most 100 characters)")
    .bail()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage("recipientName is required (at most 100 characters)"),
  body("pickupLocation")
    .isString()
    .trim()
    .isLength({ min: 1, max: 1000 })
    .withMessage("pickupLocation is required"),
  body("addressDetail")
    .optional({ values: "null" })
    .isString()
    .trim()
    .isLength({ max: 255 })
    .withMessage("addressDetail is at most 255 characters"),
  body("deliveryLatitude")
    .isFloat({ min: -90, max: 90 })
    .withMessage("deliveryLatitude is required (pin the address on the map)")
    .toFloat(),
  body("deliveryLongitude")
    .isFloat({ min: -180, max: 180 })
    .withMessage("deliveryLongitude is required (pin the address on the map)")
    .toFloat(),
  body("deliveryNote")
    .optional({ values: "null" })
    .isString()
    .trim()
    .isLength({ max: 500 })
    .withMessage("deliveryNote is at most 500 characters"),
  handleGiftRedeem,
);

export default router;
