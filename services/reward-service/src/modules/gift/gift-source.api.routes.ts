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
import { giftSourceService } from "./gift-source.service";
import { loadSourceReport, parseRange, toCsv } from "./gift-source-report";

const router = Router();
const SOURCE_TYPES = ["SPONSOR", "ECOLINK", "DONATION"] as const;
const SOURCE_STATUSES = ["ACTIVE", "INACTIVE"] as const;
const PHONE_RE = /^[0-9+\-()\s.]+$/;

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

/** Shared body rules; `required` makes name and type mandatory (create). */
const sourceBodyRules = (required: boolean) => [
  required
    ? body("name").isString().trim().isLength({ min: 1, max: 255 })
    : body("name").optional().isString().trim().isLength({ min: 1, max: 255 }),
  required ? body("type").isIn(SOURCE_TYPES) : body("type").optional().isIn(SOURCE_TYPES),
  body("contactName").optional({ values: "null" }).isString().trim().isLength({ max: 255 }),
  body("contactPhone")
    .optional({ values: "falsy" })
    .isString()
    .trim()
    .isLength({ min: 7, max: 32 })
    .matches(PHONE_RE)
    .withMessage("contactPhone must be a valid phone number"),
  body("contactEmail")
    .optional({ values: "falsy" })
    .isEmail()
    .withMessage("contactEmail must be a valid email"),
  body("logoUrl")
    .optional()
    .custom((v) => v === "" || (typeof v === "string" && /^https?:\/\//.test(v)))
    .withMessage("logoUrl must be a URL or empty"),
  body("showOnGift").optional().isBoolean(),
  body("note").optional({ values: "null" }).isString().isLength({ max: 2000 }),
];

const pageRules = [
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
];

const paged = (req: Request) => {
  const page = (req.query.page as number | undefined) ?? 1;
  const limit = (req.query.limit as number | undefined) ?? 20;
  return { page, limit };
};

const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  totalPages: total === 0 ? 0 : Math.ceil(total / limit),
});

/**
 * @route   GET /api/v1/admin/gift-sources
 * @desc    List gift sources (filter by type, status, name)
 * @access  Private (Admin)
 */
router.get(
  "/admin/gift-sources",
  ...admin,
  ...pageRules,
  query("type").optional().isIn(SOURCE_TYPES),
  query("status").optional().isIn(SOURCE_STATUSES),
  query("search").optional().isString().trim(),
  async (req, res): Promise<void> => {
    if (validationFailed(req, res)) return;
    const { page, limit } = paged(req);
    try {
      const { sources, total } = await giftSourceService.list({
        page,
        limit,
        type: req.query.type as (typeof SOURCE_TYPES)[number] | undefined,
        status: req.query.status as (typeof SOURCE_STATUSES)[number] | undefined,
        search: req.query.search as string | undefined,
      });
      sendSuccess(res, HTTP_STATUS.OK, { sources, ...pageMeta(page, limit, total) });
    } catch (error) {
      handleError(res, error, "List gift sources");
    }
  },
);

/**
 * @route   POST /api/v1/admin/gift-sources
 * @desc    Create a gift source
 * @access  Private (Admin)
 */
router.post("/admin/gift-sources", ...admin, ...sourceBodyRules(true), async (req, res): Promise<void> => {
  if (validationFailed(req, res)) return;
  try {
    const source = await giftSourceService.create(req.body, req.user?.userId ?? null);
    sendSuccess(res, HTTP_STATUS.CREATED, { source });
  } catch (error) {
    handleError(res, error, "Create gift source");
  }
});

/**
 * @route   GET /api/v1/admin/gift-sources/:id
 * @desc    Get one gift source
 * @access  Private (Admin)
 */
router.get(
  "/admin/gift-sources/:id",
  ...admin,
  param("id").isUUID("loose"),
  async (req, res): Promise<void> => {
    if (validationFailed(req, res)) return;
    try {
      const source = await giftSourceService.getById(req.params.id);
      sendSuccess(res, HTTP_STATUS.OK, { source });
    } catch (error) {
      handleError(res, error, "Get gift source");
    }
  },
);

/**
 * @route   PUT /api/v1/admin/gift-sources/:id
 * @desc    Update a gift source; status INACTIVE stops new batches (no hard delete)
 * @access  Private (Admin)
 */
router.put(
  "/admin/gift-sources/:id",
  ...admin,
  param("id").isUUID("loose"),
  ...sourceBodyRules(false),
  body("status").optional().isIn(SOURCE_STATUSES),
  async (req, res): Promise<void> => {
    if (validationFailed(req, res)) return;
    try {
      const source = await giftSourceService.update(req.params.id, req.body);
      sendSuccess(res, HTTP_STATUS.OK, { source });
    } catch (error) {
      handleError(res, error, "Update gift source");
    }
  },
);

/**
 * @route   GET /api/v1/admin/gift-sources/:id/batches
 * @desc    Stock batches received from a source, newest first
 * @access  Private (Admin)
 */
router.get(
  "/admin/gift-sources/:id/batches",
  ...admin,
  param("id").isUUID("loose"),
  ...pageRules,
  async (req, res): Promise<void> => {
    if (validationFailed(req, res)) return;
    const { page, limit } = paged(req);
    try {
      const { batches, total } = await giftSourceService.listBatches(req.params.id, { page, limit });
      sendSuccess(res, HTTP_STATUS.OK, { batches, ...pageMeta(page, limit, total) });
    } catch (error) {
      handleError(res, error, "List gift source batches");
    }
  },
);

/**
 * @route   GET /api/v1/admin/gift-sources/:id/report
 * @desc    Source report for a date range (UTC+7); format=csv downloads a file
 * @access  Private (Admin)
 */
router.get(
  "/admin/gift-sources/:id/report",
  ...admin,
  param("id").isUUID("loose"),
  query("from").optional().isString(),
  query("to").optional().isString(),
  query("format").optional().isIn(["json", "csv"]),
  async (req, res): Promise<void> => {
    if (validationFailed(req, res)) return;
    try {
      const now = new Date();
      const range = parseRange(req.query.from as string | undefined, req.query.to as string | undefined, now);
      const report = await loadSourceReport(req.params.id, range, now);
      if (req.query.format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="gift-source-${report.sourceId}-${report.from}-${report.to}.csv"`,
        );
        res.status(200).send(toCsv(report));
        return;
      }
      sendSuccess(res, HTTP_STATUS.OK, { report });
    } catch (error) {
      handleError(res, error, "Gift source report");
    }
  },
);

export default router;
