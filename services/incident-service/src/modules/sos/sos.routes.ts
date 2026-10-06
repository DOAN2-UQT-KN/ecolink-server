import { Router } from "express";
import { sosController } from "./sos.controller";
import { authenticate } from "../../middleware/auth.middleware";

const router = Router();

// Static paths first: `/:id` only takes integers, but keep them out of its way.

/** @route GET /api/v1/sos/eligibility — whether the caller may raise an SOS for a campaign, and for which shifts. */
router.get("/eligibility", authenticate, sosController.eligibility);

/** @route GET /api/v1/sos/duplicates — open SOS of the same type within 200 m. */
router.get("/duplicates", authenticate, sosController.duplicates);

/** @route GET/PUT /api/v1/sos/me/availability — the caller's "Sẵn sàng hỗ trợ SOS". */
router.get("/me/availability", authenticate, sosController.getAvailability);
router.put("/me/availability", authenticate, sosController.updateAvailability);
router.put("/me/availability/location", authenticate, sosController.updateAvailabilityLocation);

/** @route POST /api/v1/sos — raise an SOS (3 types, eligibility, 3 per hour). */
router.post("/", authenticate, sosController.createSos);

/** @route GET /api/v1/sos — map / list: live SOS, medical first, no personal data. */
router.get("/", authenticate, sosController.listSos);

/** @route GET /api/v1/sos/:id — detail, filtered by who is looking. */
router.get("/:id", authenticate, sosController.getSos);

/** @route POST|DELETE /api/v1/sos/:id/respond — "Tôi tới giúp ngay" / "Không tới được nữa". */
router.post("/:id/respond", authenticate, sosController.respond);
router.delete("/:id/respond", authenticate, sosController.cancelResponse);
router.put("/:id/respond/location", authenticate, sosController.responderLocation);

/** @route PUT /api/v1/sos/:id/location — the reporter moves the SOS. */
router.put("/:id/location", authenticate, sosController.updateLocation);

/** @route PUT /api/v1/sos/:id/resolve — close it (reporter, team, admin); `/solved` is the old alias. */
router.put("/:id/resolve", authenticate, sosController.resolveSos);
router.put("/:id/solved", authenticate, sosController.solveSos);

export default router;
