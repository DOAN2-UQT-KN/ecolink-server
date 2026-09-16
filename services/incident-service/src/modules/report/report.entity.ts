import { Prisma, Report } from "@prisma/client";
import { defaultResourceVoteSummary } from "../vote/vote.dto";
import type {
  DuplicateMediaMatch,
  DuplicateVerificationGroup,
  DuplicateVerificationGroupView,
  ReportResponse,
} from "./report.dto";

// Type-based entity
export type ReportEntity = Report;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pushUnique(ids: string[], value: unknown): void {
  if (typeof value === "string" && value && !ids.includes(value)) {
    ids.push(value);
  }
}

function parseIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const ids: string[] = [];
  for (const item of raw) {
    pushUnique(ids, item);
  }
  return ids;
}

function parseMediaMatch(item: unknown): DuplicateMediaMatch | null {
  const match = asRecord(item);
  if (match == null) {
    return null;
  }
  const mediaId = match.mediaId ?? match.media_id;
  const duplicateMediaId = match.duplicateMediaId ?? match.duplicate_media_id;
  if (typeof mediaId !== "string" || typeof duplicateMediaId !== "string") {
    return null;
  }
  return { mediaId, duplicateMediaId };
}

function matchReportId(
  item: unknown,
  fallback: string,
): string {
  const match = asRecord(item);
  if (match == null) {
    return fallback;
  }
  const raw = match.duplicateReportId ?? match.duplicate_report_id;
  return typeof raw === "string" && raw ? raw : fallback;
}

function groupFromLegacy(obj: Record<string, unknown>): DuplicateVerificationGroup[] {
  const duplicateReportIds = parseIdList(
    obj.duplicateReportIds ?? obj.duplicate_report_ids,
  );
  pushUnique(duplicateReportIds, obj.duplicateReportId ?? obj.duplicate_report_id);

  const byReport = new Map<string, DuplicateMediaMatch[]>();
  const ensure = (reportId: string): DuplicateMediaMatch[] => {
    const existing = byReport.get(reportId);
    if (existing) {
      return existing;
    }
    const created: DuplicateMediaMatch[] = [];
    byReport.set(reportId, created);
    return created;
  };

  const fallback =
    duplicateReportIds.length === 1 ? duplicateReportIds[0] : "";
  const matchesRaw = obj.matches;
  if (Array.isArray(matchesRaw)) {
    for (const item of matchesRaw) {
      const parsed = parseMediaMatch(item);
      if (parsed == null) {
        continue;
      }
      const reportId = matchReportId(item, fallback);
      if (!reportId) {
        continue;
      }
      pushUnique(duplicateReportIds, reportId);
      ensure(reportId).push(parsed);
    }
  }

  return duplicateReportIds.map((duplicateReportId) => ({
    duplicateReportId,
    matches: byReport.get(duplicateReportId) ?? [],
  }));
}

/**
 * Stored value is an array of groups. `null` means the check has not run.
 * A legacy object (`duplicateReportIds` + flat matches) is grouped on read.
 */
export function toDuplicateVerification(
  raw: Prisma.JsonValue | null | undefined,
): DuplicateVerificationGroup[] | null {
  if (raw == null) {
    return null;
  }
  if (Array.isArray(raw)) {
    const groups: DuplicateVerificationGroup[] = [];
    for (const item of raw) {
      const obj = asRecord(item);
      if (obj == null) {
        continue;
      }
      const idRaw = obj.duplicateReportId ?? obj.duplicate_report_id;
      if (typeof idRaw !== "string" || !idRaw) {
        continue;
      }
      const matches: DuplicateMediaMatch[] = [];
      if (Array.isArray(obj.matches)) {
        for (const matchItem of obj.matches) {
          const parsed = parseMediaMatch(matchItem);
          if (parsed) {
            matches.push(parsed);
          }
        }
      }
      groups.push({ duplicateReportId: idRaw, matches });
    }
    return groups;
  }

  const obj = asRecord(raw);
  if (obj == null) {
    return null;
  }
  return groupFromLegacy(obj);
}

const INACTIVE_REPORT_STATUS = 2;

/** Drop groups whose older report is missing or banned. Stored ids are unchanged. */
export function omitInactiveDuplicateGroups(
  groups: DuplicateVerificationGroup[],
  reportsById: ReadonlyMap<string, { status: number | null }>,
): DuplicateVerificationGroup[] {
  return groups.filter((group) => {
    const report = reportsById.get(group.duplicateReportId);
    return report != null && report.status !== INACTIVE_REPORT_STATUS;
  });
}

export function embedDuplicateVerification(
  groups: DuplicateVerificationGroup[] | null,
  reportsById: ReadonlyMap<
    string,
    {
      title: string | null;
      titleVi: string | null;
      detailAddress: string | null;
      status: number | null;
    }
  >,
  urlByMediaId: ReadonlyMap<string, string>,
): DuplicateVerificationGroupView[] | null {
  if (groups == null) {
    return null;
  }
  return groups.map((group) => {
    const report = reportsById.get(group.duplicateReportId);
    return {
      duplicateReportId: group.duplicateReportId,
      title: report ? (report.titleVi ?? report.title) : null,
      detailAddress: report?.detailAddress ?? null,
      status: report?.status ?? null,
      matches: group.matches.map((match) => ({
        newMedia: {
          mediaId: match.mediaId,
          url: urlByMediaId.get(match.mediaId) ?? null,
        },
        duplicateMedia: {
          duplicateMediaId: match.duplicateMediaId,
          duplicateUrl: urlByMediaId.get(match.duplicateMediaId) ?? null,
        },
      })),
    };
  });
}

export function toDuplicateVerificationJson(
  groups: DuplicateVerificationGroup[],
): Prisma.InputJsonValue {
  return groups.map((group) => ({
    duplicateReportId: group.duplicateReportId,
    matches: group.matches.map((match) => ({
      mediaId: match.mediaId,
      duplicateMediaId: match.duplicateMediaId,
    })),
  }));
}

// Helper function for conversion
export const toReportResponse = (
  entity: ReportEntity,
  distance?: number,
): ReportResponse => ({
  id: entity.id,
  userId: entity.userId,
  user: null,
  title: entity.titleVi ?? entity.title,
  titleVi: entity.titleVi ?? entity.title,
  titleEn: entity.titleEn,
  description: entity.descriptionVi ?? entity.description,
  descriptionVi: entity.descriptionVi ?? entity.description,
  descriptionEn: entity.descriptionEn,
  wasteType: entity.wasteType,
  severityLevel: entity.severityLevel,
  latitude: entity.latitude,
  longitude: entity.longitude,
  detailAddress: entity.detailAddress,
  status: entity.status,
  isVerify: entity.isVerify,
  rejectReason: entity.rejectReason ?? null,
  aiVerified: entity.aiVerified,
  aiRecommendation: entity.aiRecommendation,
  duplicateVerification: embedDuplicateVerification(
    toDuplicateVerification(entity.duplicateVerification),
    new Map(),
    new Map(),
  ),
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
  ...(distance !== undefined && { distance }),
  votes: defaultResourceVoteSummary(null),
  saved: null,
});
