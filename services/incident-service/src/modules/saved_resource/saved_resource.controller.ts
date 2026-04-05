import { Request, Response } from "express";
import { body, validationResult } from "express-validator";
import {
  HTTP_STATUS,
  sendError,
  sendHttpErrorResponse,
  sendSuccess,
} from "../../constants/http-status";
import { SavedResourceType } from "../../constants/status.enum";
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

export class SavedResourceController {
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
