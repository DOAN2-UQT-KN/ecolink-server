import axios from "axios";
import { v2 as cloudinary } from "cloudinary";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { HTTP_STATUS, HttpError } from "../../../constants/http-status";
import {
  CreateSignedUploadInput,
  DocumentDownload,
  DocumentStorage,
  SignedUpload,
} from "./document-storage";

/** Signed upload params stay valid for this long; the browser uploads immediately. */
const UPLOAD_SIGNATURE_TTL_MS = 15 * 60 * 1000;
/** Read-back URLs are minted per request and never leave the server. */
const DOWNLOAD_URL_TTL_MS = 5 * 60 * 1000;

const ROOT_FOLDER = "ecolink/organization-applications";

interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * Documents are stored with delivery `type: "authenticated"`, which means Cloudinary
 * refuses to serve them from a plain URL — every read needs a signature made with the
 * API secret. PDFs and images both live under the `image` resource type.
 */
export class CloudinaryDocumentStorage implements DocumentStorage {
  /** Read env late (never at import time) so tests and workers can run without it. */
  private config(): CloudinaryConfig {
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
    return { cloudName, apiKey, apiSecret };
  }

  createSignedUpload(input: CreateSignedUploadInput): SignedUpload {
    const { cloudName, apiKey, apiSecret } = this.config();

    const folder = `${ROOT_FOLDER}/${input.scopeId}`;
    const publicId = `${input.docType.toLowerCase()}-${randomUUID()}`;
    const timestamp = Math.floor(Date.now() / 1000);

    // Every field below is part of the signature, so the browser cannot redirect the
    // upload to another folder or downgrade it to a public delivery type.
    const paramsToSign: Record<string, string | number> = {
      folder,
      public_id: publicId,
      timestamp,
      type: "authenticated",
    };
    const signature = cloudinary.utils.api_sign_request(paramsToSign, apiSecret);

    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      fields: {
        api_key: apiKey,
        folder,
        public_id: publicId,
        timestamp: String(timestamp),
        type: "authenticated",
        signature,
      },
      storageKey: `${folder}/${publicId}`,
      expiresAt: new Date(Date.now() + UPLOAD_SIGNATURE_TTL_MS).toISOString(),
    };
  }

  async download(storageKey: string, format: string): Promise<DocumentDownload> {
    this.config();

    const url = cloudinary.utils.private_download_url(storageKey, format, {
      resource_type: "image",
      type: "authenticated",
      expires_at: Math.floor((Date.now() + DOWNLOAD_URL_TTL_MS) / 1000),
    });

    const response = await axios.get<Readable>(url, {
      responseType: "stream",
      timeout: 20_000,
    });

    const contentLength = Number(response.headers["content-length"]);
    return {
      stream: response.data,
      contentType: String(response.headers["content-type"] ?? "application/octet-stream"),
      contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
    };
  }

  async remove(storageKey: string, _format: string): Promise<void> {
    this.config();
    await cloudinary.uploader.destroy(storageKey, {
      resource_type: "image",
      type: "authenticated",
      invalidate: true,
    });
  }
}

export const documentStorage: DocumentStorage = new CloudinaryDocumentStorage();
