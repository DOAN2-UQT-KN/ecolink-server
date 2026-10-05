import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { RESULT_PHOTO_MAX_BYTES } from "@da2/constants";
import { HTTP_STATUS, sendError } from "../../../constants/http-status";

/** The original photo stays in memory: its EXIF is read and its hash taken before it is stored. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RESULT_PHOTO_MAX_BYTES, files: 1, fields: 10 },
}).single("file");

/** Multipart `file` for the result photo upload; a too large or malformed upload is a 422. */
export function resultPhotoUpload(req: Request, res: Response, next: NextFunction): void {
  upload(req, res, (error: unknown) => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
    sendError(
      res,
      HTTP_STATUS.RESULT_PHOTO_INVALID.withMessage(
        tooLarge ? "The photo is larger than 15 MB" : "Send the photo as multipart field \"file\"",
      ),
      { field: "file" },
    );
  });
}
