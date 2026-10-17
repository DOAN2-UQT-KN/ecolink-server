import axios from "axios";
import type { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";
import {
  extractMediaFieldsFromBuffer,
  type ExtractedMediaFields,
} from "./media-extract.util";

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;

export type MediaCaptureInput = {
  capturedAt?: string;
  latitude?: number;
  longitude?: number;
};

export type CreateMediaFromUrlInput = {
  url: string;
  type: string;
  userId?: string;
  capture?: MediaCaptureInput | null;
  id?: string;
};

/** Media create payload plus downloaded bytes used for EXIF extract. */
export type PreparedMediaFromUrl = {
  media: Prisma.MediaCreateManyInput;
  buffer: Buffer | null;
};

function parseCapturedAt(value?: string): Date | null {
  if (!value || typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function emptyExtracted(): ExtractedMediaFields {
  return {
    mimeType: null,
    fileSize: null,
    width: null,
    height: null,
    cameraMake: null,
    cameraModel: null,
    metadata: null,
  };
}

/**
 * Download image bytes and extract metadata. On any failure returns empty
 * extracted fields and a null buffer (caller still persists url + capture).
 */
export async function downloadAndExtractMedia(
  url: string,
): Promise<{ extracted: ExtractedMediaFields; buffer: Buffer | null }> {
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxContentLength: MAX_DOWNLOAD_BYTES,
      maxBodyLength: MAX_DOWNLOAD_BYTES,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    const buffer = Buffer.from(response.data);
    const contentType =
      typeof response.headers["content-type"] === "string"
        ? response.headers["content-type"]
        : null;

    const extracted = await extractMediaFieldsFromBuffer(buffer, contentType);
    return { extracted, buffer };
  } catch (error) {
    console.warn(
      `[media] failed to download/extract metadata for url=${url}:`,
      error instanceof Error ? error.message : error,
    );
    return { extracted: emptyExtracted(), buffer: null };
  }
}

export function buildMediaCreateData(
  input: CreateMediaFromUrlInput,
  extracted: ExtractedMediaFields,
): Prisma.MediaCreateManyInput {
  const capture = input.capture;
  return {
    ...(input.id ? { id: input.id } : {}),
    url: input.url,
    type: input.type,
    mimeType: extracted.mimeType,
    fileSize: extracted.fileSize,
    width: extracted.width,
    height: extracted.height,
    cameraMake: extracted.cameraMake,
    cameraModel: extracted.cameraModel,
    metadata: extracted.metadata ?? undefined,
    capturedAt: parseCapturedAt(capture?.capturedAt) ?? undefined,
    latitude:
      typeof capture?.latitude === "number" && Number.isFinite(capture.latitude)
        ? capture.latitude
        : undefined,
    longitude:
      typeof capture?.longitude === "number" &&
      Number.isFinite(capture.longitude)
        ? capture.longitude
        : undefined,
    createdBy: input.userId,
    updatedBy: input.userId,
  };
}

/**
 * Prepare media row data for createMany: download+extract outside the DB tx.
 */
export async function prepareMediaFromUrl(
  input: CreateMediaFromUrlInput,
): Promise<PreparedMediaFromUrl> {
  const { extracted, buffer } = await downloadAndExtractMedia(input.url);
  return {
    media: buildMediaCreateData(input, extracted),
    buffer,
  };
}

/**
 * Create a single Media row from a hosted URL (download + extract).
 * Never fails the create when extract fails.
 */
export async function createMediaFromUrl(
  input: CreateMediaFromUrlInput,
  tx?: Prisma.TransactionClient,
) {
  const db = tx ?? prisma;
  const prepared = await prepareMediaFromUrl(input);
  return db.media.create({ data: prepared.media });
}

/** Snapshot of a report media file for REPORT_SUBMITTED outbox payload. */
export function toReportSubmittedMediaSnapshot(input: {
  reportMediaFileId: string;
  mediaId: string;
  uploadedBy: string | null;
  media: Prisma.MediaCreateManyInput;
}): Record<string, unknown> {
  const m = input.media;
  const capturedAt = m.capturedAt;
  return {
    reportMediaFileId: input.reportMediaFileId,
    mediaId: input.mediaId,
    uploadedBy: input.uploadedBy,
    url: m.url,
    type: m.type,
    mimeType: m.mimeType ?? null,
    fileSize: m.fileSize != null ? String(m.fileSize) : null,
    width: m.width ?? null,
    height: m.height ?? null,
    capturedAt:
      capturedAt instanceof Date
        ? capturedAt.toISOString()
        : capturedAt
          ? String(capturedAt)
          : null,
    latitude: m.latitude ?? null,
    longitude: m.longitude ?? null,
    cameraMake: m.cameraMake ?? null,
    cameraModel: m.cameraModel ?? null,
    metadata: m.metadata ?? null,
  };
}
