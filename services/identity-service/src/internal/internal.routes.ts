import { Router } from "express";
import { body, param, validationResult } from "express-validator";
import { HTTP_STATUS, sendError, sendSuccess } from "../constants/http-status";
import { requireInternalIdentityApiKey } from "../middleware/internal-identity-auth.middleware";
import { authService } from "../modules/auth/auth.service";
import { userService } from "../modules/user/user.service";

const router = Router();

router.use(requireInternalIdentityApiKey);

/**
 * Incident-service: issue opaque token for organization contact email link.
 */
router.post(
  "/organization-contact-email/tokens",
  body("organizationId").isUUID(),
  body("contactEmail").isEmail(),
  body("ownerUserId").isUUID(),
  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }

    const { organizationId, contactEmail, ownerUserId } = req.body as {
      organizationId: string;
      contactEmail: string;
      ownerUserId: string;
    };

    try {
      const token = await authService.createOrganizationContactEmailToken({
        organizationId,
        contactEmail,
        ownerUserId,
      });
      sendSuccess(res, HTTP_STATUS.CREATED, { token });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to create token";
      if (msg.includes("Owner user not found")) {
        sendError(res, HTTP_STATUS.BAD_REQUEST.withMessage(msg));
        return;
      }
      console.error("Internal organization contact email token error:", e);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

/**
 * Incident-service: validate link token, consume it, return org + email for incident DB update.
 */
router.post(
  "/organization-contact-email/tokens/verify",
  body("token").isString().notEmpty(),
  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }

    const token = String((req.body as { token?: string }).token ?? "").trim();
    try {
      const result =
        await authService.verifyAndConsumeOrganizationContactEmailToken(token);
      if (!result) {
        sendError(
          res,
          HTTP_STATUS.NOT_FOUND.withMessage("Invalid or expired token"),
        );
        return;
      }
      sendSuccess(res, HTTP_STATUS.OK, result);
    } catch (e) {
      console.error("Internal organization contact email verify error:", e);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

/**
 * Incident-service (and peers): batch-load users by id for denormalized responses (e.g. org owner).
 */
router.post(
  "/users/by-ids",
  body("ids").isArray({ min: 1, max: 100 }),
  body("ids.*").isUUID(),
  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }

    const ids = (req.body as { ids: string[] }).ids;
    try {
      const users = await userService.getUsersByIds(ids);
      sendSuccess(res, HTTP_STATUS.OK, { users });
    } catch (error) {
      console.error("Internal users by-ids error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

router.get(
  "/users/:id/email",
  param("id").isUUID(),
  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }

    try {
      const userId = req.params?.id;
      if (!userId) {
        sendError(res, HTTP_STATUS.BAD_REQUEST.withMessage("Missing user id"));
        return;
      }
      const email = await userService.getUserEmailById(userId);
      if (!email) {
        sendError(res, HTTP_STATUS.NOT_FOUND.withMessage("User not found"));
        return;
      }
      sendSuccess(res, HTTP_STATUS.OK, { email });
    } catch (error) {
      console.error("Internal user email error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

export default router;
