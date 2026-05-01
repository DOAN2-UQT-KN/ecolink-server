import { Router, type Request as ExpressRequest } from "express";
import { param, query, validationResult } from "express-validator";
import { HTTP_STATUS, sendError } from "../../constants/http-status";
import {
  authenticate,
} from "../../middleware/auth.middleware";
import { requireAdmin } from "../../middleware/require-admin.middleware";
import * as gc from "./gamification.controller";

const router = Router();

/** express-validator widens `req` generics; controllers expect standard Express.Request */
function er(req: unknown): ExpressRequest {
  return req as ExpressRequest;
}

/**
 * @route   GET /api/v1/seasons/current
 * @desc    Current (or latest) competitive season
 * @access  Public
 */
router.get("/seasons/current", (req, res) =>
  gc.getSeasonCurrent(er(req), res),
);

/**
 * @route   GET /api/v1/seasons/:id
 * @desc    Season by id
 * @access  Public
 */
router.get(
  "/seasons/:id",
  param("id").isUUID(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void gc.getSeasonById(er(req), res);
  },
);

/**
 * @route   GET /api/v1/me/gamification/summary
 * @desc    Season RP totals + SP wallet + legacy green balance
 * @access  Private
 */
router.get("/me/gamification/summary", authenticate, (req, res) =>
  gc.getGamificationSummary(er(req), res),
);

/**
 * @route   GET /api/v1/me/gamification/point-transactions
 * @desc    Ledger (CRP / VRP / SP)
 * @access  Private
 */
router.get(
  "/me/gamification/point-transactions",
  authenticate,
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("kind").optional().isIn(["CRP", "VRP", "SP"]),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void gc.getMyPointTransactions(er(req), res);
  },
);

/**
 * @route   GET /api/v1/me/gamification/points-by-season
 * @desc    CRP, VRP, and net SP per season (SP summed from ledger over season window)
 * @access  Private
 */
router.get(
  "/me/gamification/points-by-season",
  authenticate,
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void gc.getPointsBySeason(er(req), res);
  },
);

/**
 * @route   GET /api/v1/me/badges
 * @desc    Badge grants (optional ?seasonId=)
 * @access  Private
 */
router.get(
  "/me/badges",
  authenticate,
  query("seasonId").optional().isUUID(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void gc.getMyBadges(er(req), res);
  },
);

/**
 * @route   GET /api/v1/gamification/campaign-reward-estimate
 * @desc    Public campaign UX: base + estimated range from difficulty level
 * @access  Public
 */
router.get(
  "/gamification/campaign-reward-estimate",
  query("difficultyLevel").isInt({ min: 1 }).toInt(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void gc.getCampaignRewardEstimate(er(req), res);
  },
);

/**
 * @route   GET /api/v1/gamification/leaderboards/:metric
 * @desc    CRP | VRP | ORG_AGGREGATE (case-insensitive path segment)
 * @access  Public
 */
router.get(
  "/gamification/leaderboards/:metric",
  param("metric").trim().notEmpty(),
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("seasonId").optional().isUUID(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    const r = er(req);
    r.params.metric = r.params.metric.toLowerCase();
    void gc.getGamificationLeaderboard(r, res);
  },
);

/**
 * @route   GET /api/v1/gamification/leaderboards/:metric/me
 * @desc    Caller rank for CRP or VRP
 * @access  Private
 */
router.get(
  "/gamification/leaderboards/:metric/me",
  authenticate,
  param("metric").trim().notEmpty(),
  query("seasonId").optional().isUUID(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    const r = er(req);
    r.params.metric = r.params.metric.toLowerCase();
    void gc.getGamificationLeaderboardMe(r, res);
  },
);

// --- Admin: gamification config ---

/**
 * @route   GET /api/v1/admin/gamification/point-rules
 * @desc    Active citizen milestones / volunteer bonus caps
 * @access  Private Admin
 */
router.get(
  "/admin/gamification/point-rules",
  authenticate,
  requireAdmin,
  (req, res) => gc.adminGetPointRules(er(req), res),
);

/**
 * @route   PATCH /api/v1/admin/gamification/point-rules
 * @desc    Upsert point rules
 * @access  Private Admin
 */
router.patch(
  "/admin/gamification/point-rules",
  authenticate,
  requireAdmin,
  (req, res) => gc.adminPatchPointRules(er(req), res),
);

/**
 * @route   GET /api/v1/admin/gamification/sp-rules
 * @desc    Active SP expiration rules
 * @access  Private Admin
 */
router.get(
  "/admin/gamification/sp-rules",
  authenticate,
  requireAdmin,
  (req, res) => gc.adminGetSpRules(er(req), res),
);

/**
 * @route   PATCH /api/v1/admin/gamification/sp-rules
 * @desc    Upsert SP expiration (days)
 * @access  Private Admin
 */
router.patch(
  "/admin/gamification/sp-rules",
  authenticate,
  requireAdmin,
  (req, res) => gc.adminPatchSpRules(er(req), res),
);

/**
 * @route   GET /api/v1/admin/gamification/multipliers
 * @desc    Volunteer org multipliers
 * @access  Private Admin
 */
router.get(
  "/admin/gamification/multipliers",
  authenticate,
  requireAdmin,
  (req, res) => gc.adminListMultipliers(er(req), res),
);

/**
 * @route   PUT /api/v1/admin/gamification/multipliers
 * @desc    Upsert multiplier by code
 * @access  Private Admin
 */
router.put(
  "/admin/gamification/multipliers",
  authenticate,
  requireAdmin,
  (req, res) => gc.adminPutMultiplier(er(req), res),
);

/**
 * @route   GET /api/v1/admin/gamification/season-schedules
 * @desc    Monthly / quarterly cadence metadata
 * @access  Private Admin
 */
router.get(
  "/admin/gamification/season-schedules",
  authenticate,
  requireAdmin,
  (req, res) => gc.adminListSeasonSchedules(er(req), res),
);

/**
 * @route   PUT /api/v1/admin/gamification/season-schedules
 * @desc    Upsert schedule rule by kind
 * @access  Private Admin
 */
router.put(
  "/admin/gamification/season-schedules",
  authenticate,
  requireAdmin,
  (req, res) => gc.adminPutSeasonSchedule(er(req), res),
);

/**
 * @route   GET /api/v1/admin/gamification/payout-tiers
 * @desc    Season leaderboard SP payout tiers
 * @access  Private Admin
 */
router.get(
  "/admin/gamification/payout-tiers",
  authenticate,
  requireAdmin,
  query("seasonId").optional().isUUID(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void gc.adminListPayoutTiers(er(req), res);
  },
);

/**
 * @route   POST /api/v1/admin/gamification/payout-tiers
 * @desc    Create payout tier
 * @access  Private Admin
 */
router.post(
  "/admin/gamification/payout-tiers",
  authenticate,
  requireAdmin,
  (req, res) => gc.adminCreatePayoutTier(er(req), res),
);

/**
 * @route   PATCH /api/v1/admin/gamification/payout-tiers/:id
 * @desc    Update payout tier
 * @access  Private Admin
 */
router.patch(
  "/admin/gamification/payout-tiers/:id",
  authenticate,
  requireAdmin,
  param("id").isUUID(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void gc.adminPatchPayoutTier(er(req), res);
  },
);

/**
 * @route   DELETE /api/v1/admin/gamification/payout-tiers/:id
 * @desc    Delete payout tier
 * @access  Private Admin
 */
router.delete(
  "/admin/gamification/payout-tiers/:id",
  authenticate,
  requireAdmin,
  param("id").isUUID(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void gc.adminDeletePayoutTier(er(req), res);
  },
);

/**
 * @route   GET /api/v1/admin/gamification/badges
 * @desc    Badge definitions
 * @access  Private Admin
 */
router.get(
  "/admin/gamification/badges",
  authenticate,
  requireAdmin,
  query("includeInactive").optional().isIn(["true", "false"]),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void gc.adminListBadges(er(req), res);
  },
);

/**
 * @route   POST /api/v1/admin/gamification/badges
 * @desc    Create badge definition
 * @access  Private Admin
 */
router.post(
  "/admin/gamification/badges",
  authenticate,
  requireAdmin,
  (req, res) => gc.adminCreateBadge(er(req), res),
);

/**
 * @route   PATCH /api/v1/admin/gamification/badges/:id
 * @desc    Update badge definition
 * @access  Private Admin
 */
router.patch(
  "/admin/gamification/badges/:id",
  authenticate,
  requireAdmin,
  param("id").isUUID(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void gc.adminPatchBadge(er(req), res);
  },
);

// --- Admin: seasons ---

/**
 * @route   GET /api/v1/admin/seasons
 * @desc    List seasons (admin)
 * @access  Private Admin
 */
router.get(
  "/admin/seasons",
  authenticate,
  requireAdmin,
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void gc.adminListSeasons(er(req), res);
  },
);

/**
 * @route   POST /api/v1/admin/seasons
 * @desc    Create season
 * @access  Private Admin
 */
router.post(
  "/admin/seasons",
  authenticate,
  requireAdmin,
  (req, res) => gc.adminCreateSeason(er(req), res),
);

/**
 * @route   PATCH /api/v1/admin/seasons/:id
 * @desc    Update season
 * @access  Private Admin
 */
router.patch(
  "/admin/seasons/:id",
  authenticate,
  requireAdmin,
  param("id").isUUID(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void gc.adminPatchSeason(er(req), res);
  },
);

/**
 * @route   POST /api/v1/admin/seasons/:id/freeze
 * @desc    Snapshot leaderboards and payout SP tiers
 * @access  Private Admin
 */
router.post(
  "/admin/seasons/:id/freeze",
  authenticate,
  requireAdmin,
  param("id").isUUID(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void gc.adminFreezeSeason(er(req), res);
  },
);

/**
 * @route   POST /api/v1/admin/seasons/:id/close-and-open-next
 * @desc    Close FROZEN season and open next ACTIVE window
 * @access  Private Admin
 */
router.post(
  "/admin/seasons/:id/close-and-open-next",
  authenticate,
  requireAdmin,
  param("id").isUUID(),
  (req, res): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }
    void gc.adminCloseSeasonAndOpenNext(er(req), res);
  },
);

export default router;
