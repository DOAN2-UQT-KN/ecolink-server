import { Report } from "@prisma/client";
import { defaultResourceVoteSummary } from "../vote/vote.dto";
import { ReportResponse } from "./report.dto";

// Type-based entity
export type ReportEntity = Report;

// Helper function for conversion
export const toReportResponse = (
  entity: ReportEntity,
  distance?: number,
): ReportResponse => ({
  id: entity.id,
  userId: entity.userId,
  title: entity.title,
  description: entity.description,
  wasteType: entity.wasteType,
  severityLevel: entity.severityLevel,
  latitude: entity.latitude,
  longitude: entity.longitude,
  detailAddress: entity.detailAddress,
  status: entity.status,
  isVerify: entity.isVerify,
  aiVerified: entity.aiVerified,
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
  ...(distance !== undefined && { distance }),
  votes: defaultResourceVoteSummary(null),
  saved: null,
});
