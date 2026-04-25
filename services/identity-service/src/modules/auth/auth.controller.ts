import { Request, Response } from "express";
import { body, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendSuccess,
} from "../../constants/http-status";
import { authService } from "./auth.service";
import { GoogleOauthCallbackQuery } from "./auth.dto";
import { googleOauthService } from "../oauth/google.service";

export class AuthController {
  constructor() { }

  googleAuthorize = async (req: Request, res: Response): Promise<void> => {
    try {
      const state =
        typeof req.query.state === "string" ? req.query.state : undefined;
      const authorizationUrl = googleOauthService.getAuthorizationUrl(state);
      sendSuccess(res, HTTP_STATUS.OK, { authorizationUrl });
    } catch (error) {
      console.error("Google authorize error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

  googleCallback = async (req: Request, res: Response): Promise<void> => {
    try {
      const { code, error } = req.query as GoogleOauthCallbackQuery;
      if (error) {
        return sendError(
          res,
          HTTP_STATUS.BAD_REQUEST.withMessage(
            typeof error === "string" ? error : "google_oauth_failed",
          ),
        );
      }
      if (!code) {
        return sendError(
          res,
          HTTP_STATUS.BAD_REQUEST.withMessage("no_code"),
        );
      }

      const result = await googleOauthService.handleCallback(code);
      const isProduction = process.env.NODE_ENV === "production";

      res.cookie("accessToken", result.accessToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "strict" : "lax",
        maxAge: 15 * 60 * 1000,
      });

      sendSuccess(res, HTTP_STATUS.OK, result);
    } catch (error) {
      console.error("Google callback error:", error);
      sendError(
        res,
        HTTP_STATUS.INTERNAL_SERVER_ERROR.withMessage("callback_failed"),
      );
    }
  };

  signup = [
    body("email").isEmail().withMessage("Valid email is required"),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters long"),
    body("name").notEmpty().trim().withMessage("Name is required"),
    body("roleId")
      .optional()
      .isUUID()
      .withMessage("Role ID must be a valid UUID"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(
          res,
          HTTP_STATUS.VALIDATION_ERROR.withMessage(errors.array()[0].msg),
        );
      }

      try {
        const result = await authService.signup(req.body);
        sendSuccess(res, HTTP_STATUS.CREATED, result);
      } catch (error) {
        console.error("Signup error:", error);
        if (
          error instanceof Error &&
          error.message.includes("already exists")
        ) {
          return sendError(
            res,
            HTTP_STATUS.CONFLICT.withMessage(error.message),
          );
        }
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  login = [
    body("email").isEmail().withMessage("Valid email is required"),
    body("password").notEmpty().withMessage("Password is required"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(
          res,
          HTTP_STATUS.VALIDATION_ERROR.withMessage(errors.array()[0].msg),
        );
      }

      try {
        const result = await authService.login(req.body);
        if (!result) {
          return sendError(res, HTTP_STATUS.INVALID_CREDENTIALS);
        }
        
        const isProduction = process.env.NODE_ENV === "production";

        // Set access token cookie (httpOnly)
        res.cookie("accessToken", result.accessToken, {
          httpOnly: true,
          secure: isProduction,
          sameSite: isProduction ? "strict" : "lax",
          maxAge: 15 * 60 * 1000, // 15 minutes
        });

        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("Login error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  refreshToken = async (req: Request, res: Response): Promise<void> => {
    try {
      const refreshToken = req.cookies.refreshToken || req.body.refreshToken;

      if (!refreshToken) {
        return sendError(
          res,
          HTTP_STATUS.UNAUTHORIZED.withMessage("Refresh token not provided"),
        );
      }

      const result = await authService.refreshAccessToken({ refreshToken });

      if (!result) {
        return sendError(
          res,
          HTTP_STATUS.UNAUTHORIZED.withMessage("Invalid refresh token"),
        );
      }

      sendSuccess(res, HTTP_STATUS.OK, result);
    } catch (error) {
      console.error("Token refresh error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

  updatePassword = [
    body("oldPassword").notEmpty().withMessage("Old password is required"),
    body("newPassword")
      .isLength({ min: 8 })
      .withMessage("New password must be at least 8 characters long"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(
          res,
          HTTP_STATUS.VALIDATION_ERROR.withMessage(errors.array()[0].msg),
        );
      }

      try {
        const userId = (req as any).user?.userId;
        if (!userId) {
          return sendError(res, HTTP_STATUS.UNAUTHORIZED);
        }

        const success = await authService.updatePassword({
          userId,
          oldPassword: req.body.oldPassword,
          newPassword: req.body.newPassword,
        });

        if (!success) {
          return sendError(
            res,
            HTTP_STATUS.BAD_REQUEST.withMessage("Invalid old password"),
          );
        }

        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Password updated successfully"),
        );
      } catch (error) {
        console.error("Update password error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  requestPasswordReset = [
    body("email").isEmail().withMessage("Valid email is required"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const resetToken = await authService.requestPasswordReset(req.body);

        if (!resetToken) {
          return sendError(
            res,
            HTTP_STATUS.NOT_FOUND.withMessage("User not found"),
          );
        }

        sendSuccess(res, HTTP_STATUS.OK, { resetToken });
      } catch (error) {
        console.error("Request password reset error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  resetPassword = [
    body("resetToken").notEmpty().withMessage("Reset token is required"),
    body("newPassword")
      .isLength({ min: 8 })
      .withMessage("New password must be at least 8 characters long"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const success = await authService.resetPassword(req.body);

        if (!success) {
          return sendError(
            res,
            HTTP_STATUS.BAD_REQUEST.withMessage(
              "Invalid or expired reset token",
            ),
          );
        }

        sendSuccess(
          res,
          HTTP_STATUS.OK.withMessage("Password reset successfully"),
        );
      } catch (error) {
        console.error("Reset password error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  me = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      const user = await authService.getMe(userId);
      if (!user) {
        return sendError(
          res,
          HTTP_STATUS.NOT_FOUND.withMessage("User not found"),
        );
      }

      sendSuccess(res, HTTP_STATUS.OK, { user });
    } catch (error) {
      console.error("Get current user error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };

  logout = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as any).user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      await authService.logout(userId);

      // Clear cookies
      res.clearCookie("refreshToken");
      res.clearCookie("accessToken");

      sendSuccess(res, HTTP_STATUS.OK.withMessage("Logged out successfully"));
    } catch (error) {
      console.error("Logout error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };
}

// Singleton instance
export const authController = new AuthController();
