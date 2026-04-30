import { Report } from "@prisma/client";
import { defaultResourceVoteSummary } from "../vote/vote.dto";
import type { ReportResponse } from "./report.dto";

// Type-based entity
export type ReportEntity = Report;

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
  aiVerified: entity.aiVerified,
  aiRecommendation: entity.aiRecommendation,
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
  ...(distance !== undefined && { distance }),
  votes: defaultResourceVoteSummary(null),
  saved: null,
});
