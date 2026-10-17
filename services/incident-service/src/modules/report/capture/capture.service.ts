import { v2 as cloudinary } from "cloudinary";
import type { CaptureSource, Prisma } from "@prisma/client";
import prisma from "../../../config/prisma.client";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";
import { cloudinaryPublicId } from "./cloudinary-public-id";

const ttlMs = (): number => Number(process.env.CAPTURE_TTL_MINUTES ?? 15) * 60_000;

function cloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) {
    throw new HttpError(HTTP_STATUS.INTERNAL_SERVER_ERROR.withMessage("Cloudinary is not configured"));
  }
  return { cloudName, apiKey, apiSecret };
}

/**
 * Starts a camera capture (specs/006 P03): a one-shot token valid CAPTURE_TTL_MINUTES, and an
 * upload signature that only allows writing `captures/<captureId>`. Time and owner are recorded
 * by the server, so the client cannot fake them (replaces EXIF).
 */
export async function issueCapture(userId: string) {
  const { cloudName, apiKey, apiSecret } = cloudinaryConfig();
  const capture = await prisma.mediaCapture.create({
    data: { userId, expiresAt: new Date(Date.now() + ttlMs()) },
  });
  const publicId = `captures/${capture.id}`;
  const timestamp = Math.floor(Date.now() / 1000);
  // Only these two params are signed: changing public_id makes Cloudinary reject the upload.
  const signature = cloudinary.utils.api_sign_request({ public_id: publicId, timestamp }, apiSecret);

  return {
    captureId: capture.id,
    expiresAt: capture.expiresAt,
    upload: {
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      cloudName,
      apiKey,
      timestamp,
      signature,
      publicId,
    },
  };
}

/**
 * LIVE when the image was uploaded under a valid capture of this user; GALLERY otherwise (never
 * an error). Consuming is compare-and-set on usedAt, so one capture makes at most one LIVE image.
 */
export async function resolveCaptureSources(
  tx: Prisma.TransactionClient,
  userId: string,
  images: { url: string; captureId: string | null }[],
  now: Date,
): Promise<{ captureSource: CaptureSource; captureId: string | null }[]> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim() ?? "";
  const out: { captureSource: CaptureSource; captureId: string | null }[] = [];
  for (const img of images) {
    const id = img.captureId;
    if (!id || !cloudName || cloudinaryPublicId(img.url, cloudName) !== `captures/${id}`) {
      out.push({ captureSource: "GALLERY", captureId: null });
      continue;
    }
    const consumed = await tx.mediaCapture.updateMany({
      where: { id, userId, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    out.push(consumed.count === 1 ? { captureSource: "LIVE", captureId: id } : { captureSource: "GALLERY", captureId: null });
  }
  return out;
}
