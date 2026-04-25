import { Router } from "express";
import { authController } from "./auth.controller";
import { authenticate } from "../../middleware/auth.middleware";

const router = Router();

/**
 * @route   POST /api/v1/auth/sign-up
 * @desc    Register a new user
 * @access  Public
 */
router.post("/sign-up", authController.signup);

/**
 * @route   POST /api/v1/auth/sign-in
 * @desc    Login user and get JWT token
 * @access  Public
 */
router.post("/sign-in", authController.login);

/**
 * @route   GET /api/v1/auth/oauth/google
 * @desc    Get Google OAuth authorization URL
 * @access  Public
 */
router.get("/oauth/google", authController.googleAuthorize);

/**
 * @route   GET /api/v1/auth/oauth/google/callback
 * @desc    Handle Google OAuth callback and sign in
 * @access  Public
 */
router.get("/oauth/google/callback", authController.googleCallback);

/**
 * @route   POST /api/v1/auth/refresh-token
 * @desc    Refresh access token using refresh token
 * @access  Public
 */
router.post("/refresh-token", authController.refreshToken);

/**
 * @route   POST /api/v1/auth/update-password
 * @desc    Update user password
 * @access  Private
 */
router.post("/update-password", authenticate, authController.updatePassword);

/**
 * @route   POST /api/v1/auth/request-password-reset
 * @desc    Request password reset token
 * @access  Public
 */
router.post("/request-password-reset", authController.requestPasswordReset);

/**
 * @route   POST /api/v1/auth/reset-password
 * @desc    Reset password using reset token
 * @access  Public
 */
router.post("/reset-password", authController.resetPassword);

/**
 * @route   GET /api/v1/auth/me
 * @desc    Get currently authenticated user profile
 * @access  Private
 */
router.get("/me", authenticate, authController.me);

/**
 * @route   POST /api/v1/auth/logout
 * @desc    Logout user and invalidate token
 * @access  Private
 */
router.post("/logout", authenticate, authController.logout);

export default router;
