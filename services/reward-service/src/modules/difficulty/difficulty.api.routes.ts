import { Router } from "express";
import { body, param, query, validationResult } from "express-validator";
import { HTTP_STATUS, sendError, sendSuccess } from "../../constants/http-status";
import { authenticate } from "../../middleware/auth.middleware";
import { requireAdmin } from "../../middleware/require-admin.middleware";
import { difficultyService } from "./difficulty.service";

const router = Router();

/**
 * @route   GET /api/v1/difficulties
 * @desc    List active campaign difficulty tiers (volunteer caps, green points)
 * @access  Public
 */
router.get(
  "/difficulties",
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

    const page = (req.query?.page as number | undefined) ?? 1;
    const limit = (req.query?.limit as number | undefined) ?? 20;

    try {
      const { difficulties, total } = await difficultyService.listActive(page, limit);
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

      sendSuccess(res, HTTP_STATUS.OK, {
        difficulties,
        page,
        limit,
        total,
        totalPages,
      });
    } catch (error) {
      console.error("List difficulties error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
);

/**
 * @route   PUT /api/v1/difficulties/:id
 * @desc    Update a difficulty tier
 * @access  Private (Admin only)
 */
router.put(
  "/difficulties/:id",
  authenticate,
  requireAdmin,
  param("id").isUUID().withMessage("id must be a UUID"),
  body("name").optional().trim().isLength({ min: 1, max: 64 }),
  body("nameVi").optional().trim().isLength({ min: 1, max: 64 }),
  body("nameEn").optional().trim().isLength({ min: 1, max: 64 }),
  body("maxVolunteers")
    .optional({ values: "null" })
    .custom((v) => v === null || (Number.isInteger(v) && v >= 1))
    .withMessage("maxVolunteers must be null or an integer >= 1"),
  body("greenPoints")
    .optional()
    .isInt({ min: 0 })
    .withMessage("greenPoints must be an integer >= 0"),

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
      const updated = await difficultyService.updateById(id, {
        name: req.body.name,
        nameVi: req.body.nameVi,
        nameEn: req.body.nameEn,
        maxVolunteers:
          req.body.maxVolunteers === undefined
            ? undefined
            : req.body.maxVolunteers,
        greenPoints: req.body.greenPoints,
      }, req.headers.authorization);
      if (!updated) {
        sendError(res, HTTP_STATUS.NOT_FOUND);
        return;
      }
      sendSuccess(res, HTTP_STATUS.OK, { difficulty: updated });
    } catch (error) {
      console.error("Update difficulty error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

export default router;
