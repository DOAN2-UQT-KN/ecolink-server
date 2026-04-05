import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware";
import { voteController } from "./vote.controller";

const router = Router();

/**
 * @route   POST /incident/votes/upvote
 * @desc    Upvote a report or campaign; repeat to cancel (value 0). Switches from downvote to upvote.
 * @access  Private
 */
router.post("/upvote", authenticate, voteController.upvote);

/**
 * @route   POST /incident/votes/downvote
 * @desc    Downvote a report or campaign; repeat to cancel (value 0). Switches from upvote to downvote.
 * @access  Private
 */
router.post("/downvote", authenticate, voteController.downvote);

export default router;
