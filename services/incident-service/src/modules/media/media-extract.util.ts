import exifr from "exifr";
import imageSize from "image-size";
import type { Prisma } from "@prisma/client";

export type ExtractedMediaFields = {
  mimeType: string | null;
  fileSize: bigint | null;
  width: number | null;
  height: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  metadata: Prisma.InputJsonValue | null;
};

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const n = Math.round(value);
  return n > 0 ? n : null;
}

/**
 * Extract file + EXIF fields from an image buffer. Never throws.
 */
export async function extractMediaFieldsFromBuffer(
  buffer: Buffer,
  contentType?: string | null,
): Promise<ExtractedMediaFields> {
  const fileSize = BigInt(buffer.byteLength);
  let mimeType =
    typeof contentType === "string" && contentType.includes("/")
      ? contentType.split(";")[0]!.trim().toLowerCase()
      : null;

  let width: number | null = null;
  let height: number | null = null;
  let cameraMake: string | null = null;
  let cameraModel: string | null = null;
  let metadata: Prisma.InputJsonValue | null = null;

  try {
    const dims = imageSize(buffer);
    width = asPositiveInt(dims.width);
    height = asPositiveInt(dims.height);
    if (!mimeType && dims.type) {
      const typeMap: Record<string, string> = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
        heic: "image/heic",
        heif: "image/heif",
        tiff: "image/tiff",
      };
      mimeType = typeMap[dims.type.toLowerCase()] ?? `image/${dims.type}`;
    }
  } catch {
    // Dimensions optional when buffer is not a known image.
  }

  try {
    const exif = await exifr.parse(buffer, {
      pick: [
        "Make",
        "Model",
        "ImageWidth",
        "ImageHeight",
        "ExifImageWidth",
        "ExifImageHeight",
        "DateTimeOriginal",
        "CreateDate",
        "Orientation",
        "LensModel",
        "Software",
        "GPSLatitude",
        "GPSLongitude",
      ],
      translateKeys: false,
      reviveValues: true,
    });

    if (exif && typeof exif === "object") {
      const record = exif as Record<string, unknown>;
      cameraMake = asTrimmedString(record.Make);
      cameraModel = asTrimmedString(record.Model);
      if (width == null) {
        width =
          asPositiveInt(record.ExifImageWidth) ??
          asPositiveInt(record.ImageWidth);
      }
      if (height == null) {
        height =
          asPositiveInt(record.ExifImageHeight) ??
          asPositiveInt(record.ImageHeight);
      }

      const serializable: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (value instanceof Date) {
          serializable[key] = value.toISOString();
        } else if (
          value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          serializable[key] = value;
        } else if (Array.isArray(value)) {
          serializable[key] = value;
        }
      }
      if (Object.keys(serializable).length > 0) {
        metadata = serializable as Prisma.InputJsonValue;
      }
    }
  } catch {
    // EXIF optional.
  }

  return {
    mimeType,
    fileSize,
    width,
    height,
    cameraMake,
    cameraModel,
    metadata,
  };
}
