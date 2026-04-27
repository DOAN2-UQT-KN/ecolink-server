import type { OrganizationOwnerResponse } from "../organization/organization.dto";
import type { ResourceVoteSummary } from "../vote/vote.dto";

// Request DTOs
export interface CreateReportRequest {
  title: string;
  description?: string;
  wasteType?: string;
  severityLevel?: number;
  latitude: number;
  longitude: number;
  /** Optional human-readable address for the report location. */
  detailAddress?: string;
  imageUrls: string[]; // Array of image URLs
}

export interface UpdateReportRequest {
  title?: string;
  description?: string;
  wasteType?: string;
  severityLevel?: number;
  latitude?: number;
  longitude?: number;
  detailAddress?: string;
}

export interface AddReportImagesRequest {
  imageUrls: string[];
}

/** One row from GET /api/v1/reports/media-files/by-ids (snake_case in HTTP response). */
export interface ReportMediaFileByIdResponse {
  id: string;
  reportId: string | null;
  mediaId: string;
  url: string;
  type: string;
  createdAt: Date;
}

export interface ReportSearchQuery {
  search?: string; // Search in title/description
  status?: number; // Filter by status
  wasteType?: string; // Filter by waste type
  severityLevel?: number; // Filter by severity
  latitude?: number; // User's latitude for distance sorting
  longitude?: number; // User's longitude for distance sorting
  maxDistance?: number; // Maximum distance in meters
  sortBy?: "distance" | "createdAt" | "severityLevel";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
}

/** Server-only scope for repository search (GET /my); never take from client on /search. */
export type ReportSearchWithScope = ReportSearchQuery & {
  scopedUserId?: string;
};

// Response DTOs
export interface ReportResponse {
  id: string;
  userId: string | null;
  /**
   * Reporter profile from identity-service when `userId` is set; null otherwise
   * or if identity is unavailable.
   */
  user: OrganizationOwnerResponse | null;
  title: string | null;
  description: string | null;
  wasteType: string | null;
  severityLevel: number | null;
  latitude: number | null;
  longitude: number | null;
  detailAddress: string | null;
  status: number | null;
  /** Admin verification; only admins can set true. */
  isVerify: boolean;
  aiVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  distance?: number; // Distance in meters (when searching with location)
  votes: ResourceVoteSummary;
  /**
   * Whether the current user saved this report. Null when the viewer is unknown (unauthenticated).
   */
  saved: boolean | null;
}

export interface ReportDetailResponse extends ReportResponse {
  mediaFiles: ReportMediaFileResponse[];
}

export interface ReportMediaFileResponse {
  id: string;
  mediaId: string;
  url: string | null;
  ai_analysis_url: string | null;
  uploadedBy: string | null;
  createdAt: Date;
}

// Pagination response
export interface PaginatedReportsResponse {
  reports: ReportDetailResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Status of background jobs tied to a report (e.g. AI analysis queue). */
export interface ReportBackgroundJobsStatusResponse {
  /** True when no ANALYZE_REPORT jobs are pending or in process for this report. */
  allDone: boolean;
  /** Total ANALYZE_REPORT rows in DB for this report (any terminal or active state). */
  jobCount: number;
  /** Jobs still queued or running. */
  pendingOrInProcessCount: number;
}

/** OpenAPI: `data` for endpoints returning a single report. */
export interface ReportOneEnvelopeData {
  report: ReportResponse;
}

/** OpenAPI: `data` for report detail (includes media). */
export interface ReportDetailEnvelopeData {
  report: ReportDetailResponse;
}

/** OpenAPI: `data` for GET /reports/my (same shape as search: paginated + media) */
export type ReportsListEnvelopeData = PaginatedReportsResponse;

/** OpenAPI: `data` for background job status */
export interface BackgroundJobsEnvelopeData {
  backgroundJobs: ReportBackgroundJobsStatusResponse;
}
