import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { HTTP_STATUS, HttpError } from "../../../constants/http-status";

const ROOT_FOLDER = "ecolink/campaign-results";

/**
 * Result photos (before / after of a trash point) go to Cloudinary as ordinary public images,
 * uploaded by the server once it has read the original file's EXIF. HEIC is stored as JPEG so
 * browsers can show it.
 */
export interface ResultPhotoStorage {
  upload(file: Buffer, input: { campaignId: string; mimeType: string }): Promise<string>;
}

class CloudinaryResultPhotoStorage implements ResultPhotoStorage {
  /** Read env late (never at import time) so tests and workers can run without it. */
  private configure(): void {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
    const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
    const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
    if (!cloudName || !apiKey || !apiSecret) {
      throw new HttpError(
        HTTP_STATUS.INTERNAL_SERVER_ERROR.withMessage(
          "CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET must be configured",
        ),
      );
    }
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
  }

  async upload(file: Buffer, input: { campaignId: string; mimeType: string }): Promise<string> {
    this.configure();
    const heic = input.mimeType === "image/heic" || input.mimeType === "image/heif";
    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `${ROOT_FOLDER}/${input.campaignId}`,
          resource_type: "image",
          ...(heic ? { format: "jpg" } : {}),
        },
        (error, uploaded) => {
          if (error || !uploaded) reject(error ?? new Error("Cloudinary upload failed"));
          else resolve(uploaded);
        },
      );
      stream.end(file);
    });
    return result.secure_url;
  }
}

export const resultPhotoStorage: ResultPhotoStorage = new CloudinaryResultPhotoStorage();
