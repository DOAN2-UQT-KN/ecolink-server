import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import exifr from "exifr";
import {
  RESULT_CHECK_LEVEL,
  RESULT_LAYER1_ISSUE,
  RESULT_PHOTO_EXIF_PIN_MAX_M,
  RESULT_PHOTO_MAX_AGE_HOURS,
  RESULT_PHOTO_MIME_TYPES,
  RESULT_PHOTO_PIN_POINT_MAX_M,
  type ResultCheckLevelValue,
  type ResultLayer1IssueValue,
  type ResultPhotoSideValue,
} from "@da2/constants";
import prisma from "../../../config/prisma.client";
import { haversineKm } from "../campaign-submit-validation";

type Db = Prisma.TransactionClient | typeof prisma;

const HOUR_MS = 60 * 60 * 1000;
/** A camera clock a little ahead of the server's is not "taken after sending". */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** EXIF times carry no zone unless OffsetTimeOriginal is set: the app's zone then. */
const DEFAULT_EXIF_OFFSET = "+07:00";

const LEVEL_RANK: Record<ResultCheckLevelValue, number> = { pass: 0, warn: 1, fail: 2 };

export function worstLevel(levels: ResultCheckLevelValue[]): ResultCheckLevelValue {
  return levels.reduce<ResultCheckLevelValue>(
    (worst, l) => (LEVEL_RANK[l] > LEVEL_RANK[worst] ? l : worst),
    RESULT_CHECK_LEVEL.PASS,
  );
}

const metres = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) =>
  Math.round(haversineKm(a, b) * 1000);

export interface PhotoExif {
  takenAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  cameraModel: string | null;
}

export interface PhotoGrade {
  timeCheck: ResultCheckLevelValue;
  exifLocationCheck: ResultCheckLevelValue;
  pinCheck: ResultCheckLevelValue;
  level: ResultCheckLevelValue;
  pinDistanceM: number | null;
  exifDistanceM: number | null;
}

/**
 * Layer 1, a library photo (spec table): EXIF time within 48 h before sending (none: warning;
 * older or later: fail); EXIF GPS within 100 m of the pin (none: warning); the pin within 100 m of
 * the trash point (a point without coordinates cannot be checked: warning). The photo's level is
 * the worst of the three.
 */
export function gradePhoto(input: {
  uploadedAt: Date;
  exif: Pick<PhotoExif, "takenAt" | "latitude" | "longitude">;
  pin: { latitude: number; longitude: number };
  point: { latitude: number; longitude: number } | null;
}): PhotoGrade {
  const { uploadedAt, exif, pin, point } = input;

  let timeCheck: ResultCheckLevelValue = RESULT_CHECK_LEVEL.WARN;
  if (exif.takenAt) {
    const age = uploadedAt.getTime() - exif.takenAt.getTime();
    timeCheck =
      age < -CLOCK_SKEW_MS || age > RESULT_PHOTO_MAX_AGE_HOURS * HOUR_MS
        ? RESULT_CHECK_LEVEL.FAIL
        : RESULT_CHECK_LEVEL.PASS;
  }

  let exifLocationCheck: ResultCheckLevelValue = RESULT_CHECK_LEVEL.WARN;
  let exifDistanceM: number | null = null;
  if (exif.latitude != null && exif.longitude != null) {
    exifDistanceM = metres({ latitude: exif.latitude, longitude: exif.longitude }, pin);
    exifLocationCheck =
      exifDistanceM <= RESULT_PHOTO_EXIF_PIN_MAX_M ? RESULT_CHECK_LEVEL.PASS : RESULT_CHECK_LEVEL.FAIL;
  }

  let pinCheck: ResultCheckLevelValue = RESULT_CHECK_LEVEL.WARN;
  let pinDistanceM: number | null = null;
  if (point) {
    pinDistanceM = metres(pin, point);
    pinCheck = pinDistanceM <= RESULT_PHOTO_PIN_POINT_MAX_M ? RESULT_CHECK_LEVEL.PASS : RESULT_CHECK_LEVEL.FAIL;
  }

  return {
    timeCheck,
    exifLocationCheck,
    pinCheck,
    level: worstLevel([timeCheck, exifLocationCheck, pinCheck]),
    pinDistanceM,
    exifDistanceM,
  };
}

/** "YYYY:MM:DD HH:MM:SS" (+ "+07:00") → instant; null when unreadable. */
export function parseExifDate(raw: unknown, offset?: unknown): Date | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const zone =
    typeof offset === "string" && /^[+-]\d{2}:\d{2}$/.test(offset.trim()) ? offset.trim() : DEFAULT_EXIF_OFFSET;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Reads what Layer 1 needs from the original file; nothing readable means no EXIF. */
export async function readPhotoExif(file: Buffer): Promise<PhotoExif> {
  const none: PhotoExif = { takenAt: null, latitude: null, longitude: null, cameraModel: null };
  try {
    const tags = (await exifr.parse(file, {
      tiff: true,
      exif: true,
      gps: true,
      reviveValues: false,
      pick: [
        "DateTimeOriginal",
        "OffsetTimeOriginal",
        "Model",
        "GPSLatitude",
        "GPSLongitude",
        "GPSLatitudeRef",
        "GPSLongitudeRef",
      ],
    })) as Record<string, unknown> | undefined;
    if (!tags) return none;
    const lat = typeof tags.latitude === "number" && Number.isFinite(tags.latitude) ? tags.latitude : null;
    const lng = typeof tags.longitude === "number" && Number.isFinite(tags.longitude) ? tags.longitude : null;
    const model = typeof tags.Model === "string" ? tags.Model.trim().slice(0, 120) || null : null;
    return {
      takenAt: parseExifDate(tags.DateTimeOriginal, tags.OffsetTimeOriginal),
      // (0, 0) is what some apps write when they strip the location.
      latitude: lat != null && lng != null && !(lat === 0 && lng === 0) ? lat : null,
      longitude: lat != null && lng != null && !(lat === 0 && lng === 0) ? lng : null,
      cameraModel: model,
    };
  } catch {
    return none;
  }
}

export const sha256Hex = (file: Buffer) => createHash("sha256").update(file).digest("hex");

/** The file really is one of the accepted images (the declared type is the client's word). */
export function sniffImageType(file: Buffer): (typeof RESULT_PHOTO_MIME_TYPES)[number] | null {
  if (file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) return "image/jpeg";
  if (file.length >= 8 && file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (file.length >= 12 && file.toString("latin1", 0, 4) === "RIFF" && file.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (file.length >= 12 && file.toString("latin1", 4, 8) === "ftyp") {
    const brand = file.toString("latin1", 8, 12);
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis"].includes(brand)) return "image/heic";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer 1 of a trash point
// ---------------------------------------------------------------------------

export interface Layer1Issue {
  code: ResultLayer1IssueValue;
  side?: ResultPhotoSideValue;
  url?: string;
}

export interface Layer1Result {
  level: ResultCheckLevelValue;
  issues: Layer1Issue[];
}

/** A photo of the point as Layer 1 sees it; `level` null = saved before photos were checked. */
export interface PointPhoto {
  url: string;
  side: ResultPhotoSideValue;
  level: ResultCheckLevelValue | null;
  sha256: string | null;
  exifTakenAt: Date | null;
}

/**
 * Layer 1 of a trash point: the worst of its photos (a legacy photo is a warning), plus the
 * checks on the pair: a "before" not taken earlier than every "after", the same file on both
 * sides, a file already used for another trash point or campaign (`reusedHashes`).
 */
export function pointLayer1(
  before: PointPhoto[],
  after: PointPhoto[],
  reusedHashes: ReadonlySet<string> = new Set(),
): Layer1Result {
  const issues: Layer1Issue[] = [];
  const levels: ResultCheckLevelValue[] = [];
  const add = (code: ResultLayer1IssueValue, level: ResultCheckLevelValue, p?: PointPhoto) => {
    issues.push(p ? { code, side: p.side, url: p.url } : { code });
    levels.push(level);
  };

  for (const p of [...before, ...after]) {
    if (p.level == null) add(RESULT_LAYER1_ISSUE.LEGACY_PHOTO, RESULT_CHECK_LEVEL.WARN, p);
    else if (p.level === RESULT_CHECK_LEVEL.FAIL) add(RESULT_LAYER1_ISSUE.PHOTO_FAIL, RESULT_CHECK_LEVEL.FAIL, p);
    else if (p.level === RESULT_CHECK_LEVEL.WARN) add(RESULT_LAYER1_ISSUE.PHOTO_WARN, RESULT_CHECK_LEVEL.WARN, p);
  }

  const times = (photos: PointPhoto[]) =>
    photos.filter((p) => p.exifTakenAt != null).map((p) => p.exifTakenAt!.getTime());
  const beforeTimes = times(before);
  const afterTimes = times(after);
  if (beforeTimes.length > 0 && afterTimes.length > 0 && Math.max(...beforeTimes) >= Math.min(...afterTimes)) {
    add(RESULT_LAYER1_ISSUE.BEFORE_NOT_EARLIER, RESULT_CHECK_LEVEL.FAIL);
  }

  const afterHashes = new Set(after.map((p) => p.sha256).filter((h): h is string => h != null));
  for (const p of before) {
    if (p.sha256 && afterHashes.has(p.sha256)) add(RESULT_LAYER1_ISSUE.BEFORE_AFTER_SAME, RESULT_CHECK_LEVEL.FAIL, p);
  }
  const reported = new Set<string>();
  for (const p of [...before, ...after]) {
    if (p.sha256 && reusedHashes.has(p.sha256) && !reported.has(p.sha256)) {
      reported.add(p.sha256);
      add(RESULT_LAYER1_ISSUE.HASH_REUSED, RESULT_CHECK_LEVEL.FAIL, p);
    }
  }

  return { level: worstLevel(levels), issues };
}

export type ResultPhotoCheckRow = Prisma.ResultPhotoCheckGetPayload<object>;

/** A photo's checks as the API shows them. */
export function toPhotoCheckView(row: ResultPhotoCheckRow) {
  return {
    id: row.id,
    url: row.url,
    side: row.side,
    level: row.level,
    timeCheck: row.timeCheck,
    exifLocationCheck: row.exifLocationCheck,
    pinCheck: row.pinCheck,
    exifTakenAt: row.exifTakenAt,
    exifLat: row.exifLat,
    exifLng: row.exifLng,
    cameraModel: row.cameraModel,
    pinLat: row.pinLat,
    pinLng: row.pinLng,
    pinDistanceM: row.pinDistanceM,
    exifDistanceM: row.exifDistanceM,
    uploadedAt: row.uploadedAt,
  };
}

export type PhotoCheckView = ReturnType<typeof toPhotoCheckView>;

export interface PointLayer1View extends Layer1Result {
  /** Every photo of the point with its checks; `check` null = saved before photos were checked. */
  photos: Array<{ url: string; side: ResultPhotoSideValue; check: PhotoCheckView | null }>;
}

/**
 * Layer 1 of several trash points of a campaign from their photo URLs: each URL's latest check
 * for that report, and which files were already used for another trash point (with a saved
 * result) or another campaign.
 */
export async function layer1ForPoints(
  campaignId: string,
  points: Array<{ reportId: string; beforeUrls: string[]; afterUrls: string[] }>,
  db: Db = prisma,
): Promise<Map<string, PointLayer1View>> {
  const out = new Map<string, PointLayer1View>();
  if (points.length === 0) return out;
  const urls = [...new Set(points.flatMap((p) => [...p.beforeUrls, ...p.afterUrls]))];
  const checks = urls.length
    ? await db.resultPhotoCheck.findMany({
        where: { campaignId, url: { in: urls }, reportId: { in: points.map((p) => p.reportId) } },
        orderBy: { uploadedAt: "asc" },
      })
    : [];
  const byKey = new Map(checks.map((c) => [`${c.reportId} ${c.url}`, c]));
  const hashes = [...new Set(checks.map((c) => c.sha256))];
  const others = hashes.length
    ? await db.resultPhotoCheck.findMany({
        where: { sha256: { in: hashes } },
        select: { sha256: true, campaignId: true, reportId: true, url: true },
      })
    : [];
  // Another trash point of this campaign counts only when that photo is in its saved result.
  const sameCampaignOthers = others.filter((o) => o.campaignId === campaignId);
  const usedElsewhere = new Set<string>();
  if (sameCampaignOthers.length > 0) {
    const results = await db.campaignShiftResultReport.findMany({
      where: {
        result: { campaignId },
        reportId: { in: [...new Set(sameCampaignOthers.map((o) => o.reportId))] },
      },
      select: { reportId: true, beforeUrls: true, afterUrls: true },
    });
    for (const r of results) {
      for (const u of [...r.beforeUrls, ...r.afterUrls]) usedElsewhere.add(`${r.reportId} ${u}`);
    }
  }

  for (const p of points) {
    const reused = new Set<string>();
    for (const o of others) {
      if (o.campaignId !== campaignId) reused.add(o.sha256);
      else if (o.reportId !== p.reportId && usedElsewhere.has(`${o.reportId} ${o.url}`)) reused.add(o.sha256);
    }
    const photo = (url: string, side: ResultPhotoSideValue) => {
      const c = byKey.get(`${p.reportId} ${url}`);
      return {
        point: {
          url,
          side,
          level: (c?.level as ResultCheckLevelValue | undefined) ?? null,
          sha256: c?.sha256 ?? null,
          exifTakenAt: c?.exifTakenAt ?? null,
        } satisfies PointPhoto,
        view: { url, side, check: c ? toPhotoCheckView(c) : null },
      };
    };
    const before = p.beforeUrls.map((u) => photo(u, "before"));
    const after = p.afterUrls.map((u) => photo(u, "after"));
    const ownHashes = new Set([...before, ...after].map((x) => x.point.sha256).filter(Boolean) as string[]);
    const relevant = new Set([...reused].filter((h) => ownHashes.has(h)));
    const result = pointLayer1(
      before.map((x) => x.point),
      after.map((x) => x.point),
      relevant,
    );
    out.set(p.reportId, { ...result, photos: [...before, ...after].map((x) => x.view) });
  }
  return out;
}
