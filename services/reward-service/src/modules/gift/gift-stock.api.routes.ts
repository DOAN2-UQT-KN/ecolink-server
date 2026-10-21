import { Router, type Request, type Response } from "express";
import { body, param, query, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { authenticate } from "../../middleware/auth.middleware";
import { requireAdmin } from "../../middleware/require-admin.middleware";
import { giftStockService } from "./gift-stock.service";

const router = Router();
const ADJUST_REASONS = ["DAMAGED", "LOST", "COUNT_SHORTAGE", "RETURN_TO_SOURCE"] as const;
const MAX_ATTACHMENTS = 5;
const MOVEMENT_TYPES = ["STOCK_IN", "REDEEM_OUT", "CANCEL_RETURN", "ADJUST_OUT", "EXPIRED"] as const;

const admin = [authenticate, requireAdmin];

function validationFailed(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
  return true;
}

function handleError(res: Response, error: unknown, label: string): void {
  if (sendHttpErrorResponse(res, error)) return;
  console.error(`${label} error:`, error);
  sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

const pageRules = [
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
];

const paged = (req: Request) => ({
  page: (req.query.page as number | undefined) ?? 1,
  limit: (req.query.limit as number | undefined) ?? 20,
});

const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  totalPages: total === 0 ? 0 : Math.ceil(total / limit),
});

/**
 * @route   GET /api/v1/admin/gifts/:id/stock-batches
 * @desc    Stock batches of a gift, in the order redemptions take from them
 * @access  Private (Admin)
 */
router.get(
  "/admin/gifts/:id/stock-batches",
  ...admin,
  param("id").isUUID(),
  ...pageRules,
  query("sourceId").optional().isUUID(),
  async (req, res): Promise<void> => {
    if (validationFailed(req, res)) return;
    const { page, limit } = paged(req);
    try {
      const { batches, total } = await giftStockService.listBatches(req.params.id, {
        page,
        limit,
        sourceId: req.query.sourceId as string | undefined,
      });
      sendSuccess(res, HTTP_STATUS.OK, { batches, ...pageMeta(page, limit, total) });
    } catch (error) {
      handleError(res, error, "List stock batches");
    }
  },
);

/**
 * @route   POST /api/v1/admin/gifts/:id/stock-batches
 * @desc    Receive a stock batch from an active source
 * @access  Private (Admin)
 */
router.post(
  "/admin/gifts/:id/stock-batches",
  ...admin,
  param("id").isUUID(),
  body("sourceId").isUUID(),
  body("quantity").isInt({ min: 1 }).withMessage("quantity must be an integer >= 1"),
  body("unitValueVnd").isInt({ min: 0 }).withMessage("unitValueVnd must be an integer >= 0"),
  body("receivedAt")
    .isISO8601()
    .custom((v) => new Date(v).getTime() <= Date.now())
    .withMessage("receivedAt must not be in the future"),
  body("expiresAt")
    .optional({ values: "null" })
    .isISO8601()
    .custom((v, { req }) => new Date(v).getTime() > new Date(req.body.receivedAt).getTime())
    .withMessage("expiresAt must be after receivedAt"),
  // A document number, uploaded proof files, or both (spec 015 FR-010).
  body("reference").optional({ values: "null" }).isString().trim().isLength({ max: 255 }),
  body("attachmentUrls")
    .optional()
    .isArray({ max: MAX_ATTACHMENTS })
    .withMessage(`attachmentUrls must be an array of at most ${MAX_ATTACHMENTS} URLs`),
  body("attachmentUrls.*").isURL({ protocols: ["http", "https"], require_protocol: true }),
  body("reference")
    .custom((v, { req }) => Boolean(String(v ?? "").trim()) || (req.body.attachmentUrls?.length ?? 0) > 0)
    .withMessage("Enter a reference or attach a document"),
  body("note").optional({ values: "null" }).isString().isLength({ max: 2000 }),
  async (req, res): Promise<void> => {
    if (validationFailed(req, res)) return;
    try {
      const result = await giftStockService.stockIn(
        req.params.id,
        {
          sourceId: req.body.sourceId,
          quantity: req.body.quantity,
          unitValueVnd: req.body.unitValueVnd,
          receivedAt: new Date(req.body.receivedAt),
          expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
          reference: req.body.reference ?? "",
          attachmentUrls: req.body.attachmentUrls,
          note: req.body.note,
        },
        req.user?.userId ?? null,
      );
      sendSuccess(res, HTTP_STATUS.CREATED, result);
    } catch (error) {
      handleError(res, error, "Stock in");
    }
  },
);

/**
 * @route   POST /api/v1/admin/stock-batches/:id/adjustments
 * @desc    Write items off a batch with a reason (no increase: receive a new batch instead)
 * @access  Private (Admin)
 */
router.post(
  "/admin/stock-batches/:id/adjustments",
  ...admin,
  param("id").isUUID(),
  body("quantity").isInt({ min: 1 }).withMessage("quantity must be an integer >= 1"),
  body("reason").isIn(ADJUST_REASONS),
  body("note").optional({ values: "null" }).isString().isLength({ max: 2000 }),
  async (req, res): Promise<void> => {
    if (validationFailed(req, res)) return;
    try {
      const result = await giftStockService.adjust(
        req.params.id,
        { quantity: req.body.quantity, reason: req.body.reason, note: req.body.note },
        req.user!.userId,
      );
      sendSuccess(res, HTTP_STATUS.CREATED, result);
    } catch (error) {
      handleError(res, error, "Adjust stock batch");
    }
  },
);

/**
 * @route   GET /api/v1/admin/gifts/:id/stock-movements
 * @desc    Stock history of a gift, newest first
 * @access  Private (Admin)
 */
router.get(
  "/admin/gifts/:id/stock-movements",
  ...admin,
  param("id").isUUID(),
  ...pageRules,
  query("batchId").optional().isUUID(),
  query("type").optional().isIn(MOVEMENT_TYPES),
  async (req, res): Promise<void> => {
    if (validationFailed(req, res)) return;
    const { page, limit } = paged(req);
    try {
      const { movements, total } = await giftStockService.listMovements(req.params.id, {
        page,
        limit,
        batchId: req.query.batchId as string | undefined,
        type: req.query.type as (typeof MOVEMENT_TYPES)[number] | undefined,
      });
      sendSuccess(res, HTTP_STATUS.OK, { movements, ...pageMeta(page, limit, total) });
    } catch (error) {
      handleError(res, error, "List stock movements");
    }
  },
);

export default router;
