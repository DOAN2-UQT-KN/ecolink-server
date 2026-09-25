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
 * Incident-service: create (or return) the single login that operates an organization.
 *
 * Idempotent on `applicationId` — the caller reaches this through its outbox relay, which
 * retries on any failure, and a retry must not create a second account.
 */
router.post(
  "/users/provision-org-account",
  body("applicationId").isUUID(),
  body("organizationId").isUUID(),
  body("email").isEmail(),
  body("displayName").notEmpty().trim().isLength({ max: 200 }),
  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }

    const { applicationId, organizationId, email, displayName } = req.body as {
      applicationId: string;
      organizationId: string;
      email: string;
      displayName: string;
    };

    try {
      const result = await authService.provisionOrgAccount({
        applicationId,
        organizationId,
        email,
        displayName,
      });
      sendSuccess(res, HTTP_STATUS.CREATED, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to provision account";
      if (msg === "ORG_ACCOUNT_EMAIL_TAKEN") {
        // A human already signed up with the organization's contact address. Retrying will
        // not help, so the caller gets a 409 and an admin has to resolve it.
        sendError(
          res,
          HTTP_STATUS.CONFLICT.withMessage(
            "An account already exists for this contact email",
          ),
        );
        return;
      }
      console.error("Internal provision org account error:", e);
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
/**
 * Incident-service: user ids whose saved location is within `radiusMeters` of the point.
 */
router.post(
  "/users/nearby-ids",
  body("latitude").isFloat({ min: -90, max: 90 }),
  body("longitude").isFloat({ min: -180, max: 180 }),
  body("radiusMeters")
    .optional()
    .isFloat({ min: 1, max: 200_000 })
    .withMessage("radiusMeters must be between 1 and 200000"),
  body("excludeUserIds").optional().isArray({ max: 500 }),
  body("excludeUserIds.*").optional().isUUID(),
  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }

    const body = req.body as {
      latitude: number;
      longitude: number;
      radiusMeters?: number;
      excludeUserIds?: string[];
    };
    const radiusMeters = body.radiusMeters ?? 5000;
    const excludeUserIds = body.excludeUserIds ?? [];

    try {
      const userIds = await userService.findUserIdsNearPointForInternal({
        latitude: body.latitude,
        longitude: body.longitude,
        radiusMeters,
        excludeUserIds,
      });
      sendSuccess(res, HTTP_STATUS.OK, { userIds });
    } catch (error) {
      console.error("Internal users nearby-ids error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

/**
 * Incident-service: all users with Haversine distance (m) from a point (debug on campaign create).
 */
router.post(
  "/users/distance-from-point",
  body("latitude").isFloat({ min: -90, max: 90 }),
  body("longitude").isFloat({ min: -180, max: 180 }),
  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }

    const body = req.body as { latitude: number; longitude: number };

    try {
      const users = await userService.findUsersWithDistanceFromPointForInternal({
        latitude: body.latitude,
        longitude: body.longitude,
      });
      sendSuccess(res, HTTP_STATUS.OK, { users });
    } catch (error) {
      console.error("Internal users distance-from-point error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },
);

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

/**
 * Incident-service: filter user ids that opted in for a notification kind.
 */
router.post(
  "/users/notification-prefs/filter",
  body("userIds").isArray({ min: 1, max: 500 }),
  body("userIds.*").isUUID(),
  body("kind").isString().notEmpty(),
  async (req, res): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
      return;
    }

    const { userIds, kind } = req.body as {
      userIds: string[];
      kind: string;
    };

    try {
      const enabledUserIds = await userService.filterUserIdsForNotificationKind({
        userIds,
        kind,
      });
      sendSuccess(res, HTTP_STATUS.OK, { userIds: enabledUserIds });
    } catch (error) {
      console.error("Internal notification-prefs filter error:", error);
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
