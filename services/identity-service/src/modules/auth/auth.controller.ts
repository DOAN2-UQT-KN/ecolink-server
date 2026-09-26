import { Request, Response } from "express";
import { body, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendSuccess,
} from "../../constants/http-status";
import { authService } from "./auth.service";
import {
  buildAccountActivationUrl,
  enqueueAccountActivationEmail,
} from "./account-activation-notify.client";
import { GoogleOauthCallbackQuery } from "./auth.dto";
import { googleOauthService } from "../oauth/google.service";
import logger from "../../logger";

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
      if (error instanceof Error && error.message === "ACCOUNT_BANNED") {
        return sendError(
          res,
          HTTP_STATUS.FORBIDDEN.withMessage("Account banned"),
        );
      }
      if (
        error instanceof Error &&
        error.message === "ACCOUNT_PENDING_ACTIVATION"
      ) {
        return sendError(
          res,
          HTTP_STATUS.ACCOUNT_PENDING_ACTIVATION,
        );
      }
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

      logger.info({ email: req.body?.email }, "signup attempt");
      try {
        const result = await authService.signup(req.body);
        logger.info({ email: req.body?.email }, "signup success");
        sendSuccess(res, HTTP_STATUS.CREATED, result);
      } catch (error) {
        logger.error({ email: req.body?.email, err: error }, "signup failed");
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

      logger.info({ email: req.body?.email }, "login attempt");
      try {
        const result = await authService.login(req.body);
        if (!result) {
          logger.warn({ email: req.body?.email }, "login invalid credentials");
          return sendError(res, HTTP_STATUS.INVALID_CREDENTIALS);
        }

        logger.info({ email: req.body?.email }, "login success");
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
        if (error instanceof Error && error.message === "ACCOUNT_BANNED") {
          logger.warn({ email: req.body?.email }, "login banned account");
          return sendError(
            res,
            HTTP_STATUS.FORBIDDEN.withMessage("Account banned"),
          );
        }
        if (
          error instanceof Error &&
          error.message === "ACCOUNT_PENDING_ACTIVATION"
        ) {
          logger.warn(
            { email: req.body?.email },
            "login on account pending activation",
          );
          return sendError(
            res,
            HTTP_STATUS.ACCOUNT_PENDING_ACTIVATION,
          );
        }
        logger.error({ email: req.body?.email, err: error }, "login failed");
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

  /**
   * Redeems the activation link mailed to an approved owner who had no account, and sets the
   * first password. Separate from `resetPassword`: the token type, the account state it lifts
   * and the audience all differ.
   */
  activateAccount = [
    body("token").notEmpty().withMessage("Activation token is required"),
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
        const { token, newPassword } = req.body as {
          token: string;
          newPassword: string;
        };
        const success = await authService.activateAccount(token, newPassword);

        if (!success) {
          return sendError(
            res,
            HTTP_STATUS.BAD_REQUEST.withMessage(
              "Invalid or expired activation token",
            ),
          );
        }

        sendSuccess(res, HTTP_STATUS.OK.withMessage("Account activated"));
      } catch (error) {
        console.error("Activate account error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  /**
   * "Resend activation email". Always answers the same way so it cannot be used to find out
   * which emails have a pending account.
   */
  resendActivation = [
    body("email").isEmail().withMessage("Valid email is required"),

    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      try {
        const issued = await authService.requestActivationResend(
          String(req.body.email),
        );
        if (issued) {
          await enqueueAccountActivationEmail({
            toEmail: issued.email,
            fullName: issued.name,
            activationUrl: buildAccountActivationUrl(issued.token),
            expiresInHours: authService.activationTtlHours(),
          }).catch((err) => {
            console.error("Resend activation email failed:", err);
          });
        }
      } catch (error) {
        console.error("Resend activation error:", error);
      }
      sendSuccess(
        res,
        HTTP_STATUS.OK.withMessage(
          "If this email has an account waiting for activation, a new link is on its way",
        ),
      );
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
