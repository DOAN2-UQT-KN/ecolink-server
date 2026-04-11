import { Request, Response } from "express";
import { body, query, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { SavedResourceType } from "../../constants/status.enum";
import type { SavedResourceListQuery } from "./saved_resource.dto";
import { savedResourceService } from "./saved_resource.service";

const savedResourceTypeValues = Object.values(SavedResourceType).filter(
  (v): v is SavedResourceType => typeof v === "string",
);

const saveResourceValidators = [
  body("resourceId").isUUID().withMessage("resourceId must be a valid UUID"),
  body("resourceType")
    .isIn(savedResourceTypeValues)
    .withMessage(
      `resourceType must be one of: ${savedResourceTypeValues.join(", ")}`,
    ),
];

const savedResourceListQueryValidators = [
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  query("resourceType")
    .optional()
    .isIn(savedResourceTypeValues)
    .withMessage(
      `resourceType must be one of: ${savedResourceTypeValues.join(", ")}`,
    ),
  query("sortBy").optional().isIn(["createdAt", "updatedAt"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
];

export class SavedResourceController {
  list = [
    ...savedResourceListQueryValidators,
    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      const q: SavedResourceListQuery = {
        page: req.query.page
          ? parseInt(String(req.query.page), 10)
          : undefined,
        limit: req.query.limit
          ? parseInt(String(req.query.limit), 10)
          : undefined,
        resourceType: req.query.resourceType
          ? (String(req.query.resourceType) as SavedResourceType)
          : undefined,
        sortBy: req.query.sortBy as SavedResourceListQuery["sortBy"],
        sortOrder: req.query.sortOrder as SavedResourceListQuery["sortOrder"],
      };

      try {
        const result = await savedResourceService.listForUser(userId, q);
        sendSuccess(res, HTTP_STATUS.OK, result);
      } catch (error) {
        console.error("List saved resources error:", error);
        sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    },
  ];

  save = [
    ...saveResourceValidators,
    async (req: Request, res: Response): Promise<void> => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
          errors: errors.array(),
        });
      }

      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, HTTP_STATUS.UNAUTHORIZED);
      }

      try {
        const savedResource = await savedResourceService.save(userId, {
          resourceId: req.body.resourceId,
          resourceType: req.body.resourceType as SavedResourceType,
        });
        return sendSuccess(res, HTTP_STATUS.OK, { savedResource });
      } catch (error) {
        if (sendHttpErrorResponse(res, error)) {
          return;
        }
        throw error;
      }
    },
  ];
}

export const savedResourceController = new SavedResourceController();
