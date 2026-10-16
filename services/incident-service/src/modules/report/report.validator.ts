import { body, param, query } from "express-validator";
import { ModerationReasonCode, ReportCategory, WasteType } from "@prisma/client";

const REPORT_STATUSES_QUERY_MAX = 25;
const REPORT_IMAGES_MAX = 10;

let warnedMissingCloudName = false;

/** Report images must be uploads to Ecolink's own Cloudinary account (specs/006 BR-100). */
export function isEcolinkImageUrl(url: string): boolean {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  if (!cloudName) {
    if (!warnedMissingCloudName) {
      console.warn("[report] CLOUDINARY_CLOUD_NAME is not set; only checking that image URLs use https");
      warnedMissingCloudName = true;
    }
    return url.startsWith("https://");
  }
  return url.startsWith(`https://res.cloudinary.com/${cloudName}/image/upload/`);
}

export const reportSearchQueryValidators = [
  query("search").optional().trim(),
  query("status").optional().isInt(),
  query("statuses")
    .optional()
    .custom((value) => {
      if (value === undefined || value === null || value === "") {
        return true;
      }
      const raw = Array.isArray(value)
        ? value.flatMap((v) => String(v).split(","))
        : String(value).split(",");
      const tokens = raw.map((s) => String(s).trim()).filter((s) => s.length > 0);
      if (tokens.length === 0) {
        return true;
      }
      if (tokens.length > REPORT_STATUSES_QUERY_MAX) {
        throw new Error(
          `statuses must contain at most ${REPORT_STATUSES_QUERY_MAX} values`,
        );
      }
      if (!tokens.every((t) => /^-?\d+$/.test(t))) {
        throw new Error("statuses must be integer(s)");
      }
      return true;
    }),
  query("wasteType").optional().trim(),
  query("severityLevel").optional().isInt({ min: 1, max: 5 }),
  query("latitude").optional().isFloat({ min: -90, max: 90 }),
  query("longitude").optional().isFloat({ min: -180, max: 180 }),
  query("maxDistance").optional().isInt({ min: 1 }),
  query("sortBy").optional().isIn(["distance", "createdAt", "severityLevel"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 100 }),
];

export const createReportValidators = [
  body("title").notEmpty().withMessage("Title is required").trim(),
  body("description").optional().trim(),
  body("wasteType").optional().trim(),
  body("category")
    .optional()
    .isIn(Object.values(ReportCategory))
    .withMessage("Invalid category"),
  body("wasteTypes")
    .optional()
    .isArray({ min: 1 })
    .withMessage("wasteTypes must be a non-empty array"),
  body("wasteTypes.*")
    .isIn(Object.values(WasteType))
    .withMessage("Invalid waste type"),
  body("severityLevel")
    .optional()
    .isInt({ min: 1, max: 5 })
    .withMessage("Severity level must be between 1 and 5"),
  body("latitude")
    .exists({ values: "null" })
    .withMessage("Latitude is required")
    .bail()
    .isFloat({ min: -90, max: 90 })
    .withMessage("Invalid latitude"),
  body("longitude")
    .exists({ values: "null" })
    .withMessage("Longitude is required")
    .bail()
    .isFloat({ min: -180, max: 180 })
    .withMessage("Invalid longitude"),
  body("detailAddress").optional().trim(),
  body()
    .custom((b) => Array.isArray(b?.images) || Array.isArray(b?.imageUrls))
    .withMessage("images is required"),
  body("images")
    .optional()
    .isArray({ min: 1, max: REPORT_IMAGES_MAX })
    .withMessage(`images must contain 1 to ${REPORT_IMAGES_MAX} items`),
  body("images.*.url")
    .isString()
    .withMessage("Image URL must be a string")
    .bail()
    .trim()
    .custom(isEcolinkImageUrl)
    .withMessage("Image URL must be an Ecolink Cloudinary upload"),
  body("images.*.captureId")
    .optional()
    .isUUID()
    .withMessage("captureId must be a UUID"),
  // Legacy (client trước spec 007): imageUrls. Xoá ở P10.
  body("imageUrls")
    .optional()
    .isArray({ min: 1, max: REPORT_IMAGES_MAX })
    .withMessage(`imageUrls must contain 1 to ${REPORT_IMAGES_MAX} items`),
  body("imageUrls.*")
    .isString()
    .withMessage("Each image_url must be a string")
    .bail()
    .trim()
    .notEmpty()
    .withMessage("Each image_url must not be empty")
    .bail()
    .custom(isEcolinkImageUrl)
    .withMessage("Image URL must be an Ecolink Cloudinary upload"),
  body("mediaCaptures")
    .optional()
    .isArray()
    .withMessage("mediaCaptures must be an array"),
  body("mediaCaptures.*.capturedAt")
    .optional()
    .isISO8601()
    .withMessage("mediaCaptures.capturedAt must be an ISO8601 datetime"),
  body("mediaCaptures.*.latitude")
    .optional()
    .isFloat({ min: -90, max: 90 })
    .withMessage("mediaCaptures.latitude must be between -90 and 90"),
  body("mediaCaptures.*.longitude")
    .optional()
    .isFloat({ min: -180, max: 180 })
    .withMessage("mediaCaptures.longitude must be between -180 and 180"),
];

export const updateReportValidators = [
  body("title").optional().trim(),
  body("titleVi").optional().trim(),
  body("titleEn").optional().trim(),
  body("description").optional().trim(),
  body("descriptionVi").optional().trim(),
  body("descriptionEn").optional().trim(),
  body("lang").optional().isIn(["vi", "en"]),
  body("wasteType").optional().trim(),
  body("severityLevel")
    .optional()
    .isInt({ min: 1, max: 5 })
    .withMessage("Severity level must be between 1 and 5"),
  body("latitude")
    .optional()
    .isFloat({ min: -90, max: 90 })
    .withMessage("Invalid latitude"),
  body("longitude")
    .optional()
    .isFloat({ min: -180, max: 180 })
    .withMessage("Invalid longitude"),
  body("detailAddress").optional().trim(),
];

export const addReportImagesValidators = [
  body("imageUrls")
    .isArray({ min: 1 })
    .withMessage("imageUrls must be a non-empty array"),
  body("imageUrls.*")
    .isString()
    .withMessage("Each image URL must be a string")
    .bail()
    .trim()
    .notEmpty()
    .withMessage("Each image URL must not be empty"),
  body("mediaCaptures")
    .optional()
    .isArray()
    .withMessage("mediaCaptures must be an array"),
  body("mediaCaptures.*.capturedAt")
    .optional()
    .isISO8601()
    .withMessage("mediaCaptures.capturedAt must be an ISO8601 datetime"),
  body("mediaCaptures.*.latitude")
    .optional()
    .isFloat({ min: -90, max: 90 })
    .withMessage("mediaCaptures.latitude must be between -90 and 90"),
  body("mediaCaptures.*.longitude")
    .optional()
    .isFloat({ min: -180, max: 180 })
    .withMessage("mediaCaptures.longitude must be between -180 and 180"),
];

export const reportIdParamValidator = [
  param("id").isUUID().withMessage("Report ID must be a valid UUID"),
];

export const deleteReportMediaFileValidators = [
  param("mediaFileId")
    .isUUID()
    .withMessage("mediaFileId must be a valid UUID"),
];

export const adminBanReportValidators = [
  ...reportIdParamValidator,
  body("rejectReason")
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: 5000 })
    .withMessage("reject_reason is required when banning a report"),
  body("reasonCode")
    .optional()
    .isIn(Object.values(ModerationReasonCode))
    .withMessage("Invalid reason_code"),
];
