import type { OrganizationOwnerResponse } from "../organization/organization.dto";
import type { ResourceVoteSummary } from "../vote/vote.dto";

/** Optional capture context aligned by index with `imageUrls`. */
export interface MediaCaptureInput {
  capturedAt?: string;
  latitude?: number;
  longitude?: number;
}

// Request DTOs
export interface CreateReportRequest {
  title: string;
  titleVi?: string;
  titleEn?: string;
  description?: string;
  descriptionVi?: string;
  descriptionEn?: string;
  wasteType?: string;
  severityLevel?: number;
  latitude: number;
  longitude: number;
  /** Optional human-readable address for the report location. */
  detailAddress?: string;
  imageUrls: string[]; // Array of image URLs
  /** Optional; `mediaCaptures[i]` maps to `imageUrls[i]`. */
  mediaCaptures?: MediaCaptureInput[];
}

export interface UpdateReportRequest {
  title?: string;
  titleVi?: string;
  titleEn?: string;
  description?: string;
  descriptionVi?: string;
  descriptionEn?: string;
  wasteType?: string;
  severityLevel?: number;
  latitude?: number;
  longitude?: number;
  detailAddress?: string;
}

export interface AddReportImagesRequest {
  imageUrls: string[];
  /** Optional; `mediaCaptures[i]` maps to `imageUrls[i]`. */
  mediaCaptures?: MediaCaptureInput[];
}

/** Body for PUT /api/v1/reports/:id/ban (admin). */
export interface AdminBanReportBody {
  /** Required when banning. */
  rejectReason: string;
}

/** Shared media metadata fields returned on report media responses. */
export interface MediaMetadataResponse {
  mimeType: string | null;
  /** BigInt serialized as string for JSON safety. */
  fileSize: string | null;
  width: number | null;
  height: number | null;
  capturedAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  metadata: unknown | null;
}

/** One row from GET /api/v1/reports/media-files/by-ids (snake_case in HTTP response). */
export interface ReportMediaFileByIdResponse extends MediaMetadataResponse {
  id: string;
  reportId: string | null;
  mediaId: string;
  url: string;
  type: string;
  createdAt: Date;
}

export interface ReportSearchQuery {
  search?: string; // Search in title/description
  status?: number; // Filter by a single status (legacy)
  /** Filter by any of these statuses (`status IN statuses`). Omit to keep legacy `status` / unfiltered behavior. */
  statuses?: number[];
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

export interface DuplicateMediaMatch {
  /** Media.id on the report that was just submitted. */
  mediaId: string;
  /** Media.id on the older duplicate report. */
  duplicateMediaId: string;
  /** Detect method, e.g. EXACT_HASH_MATCH, HIGH_IMAGE_SIMILARITY. */
  reason: string;
}

/**
 * Result of SHA-256 / pHash duplicate verification for a report.
 * `null` on the parent report until ai-service writes back after REPORT_SUBMITTED.
 * No hit: `duplicateReportId` and `reason` are null and `matches` is empty.
 */
export interface DuplicateVerification {
  /** Older report id that matched; null when unique or not yet checked is represented via parent null. */
  duplicateReportId: string | null;
  /** Final verdict after verification, e.g. DUPLICATE_IMAGE, SAME_PLACE. */
  reason: string | null;
  /** Media pairs that caused the match on the winning duplicate report. */
  matches: DuplicateMediaMatch[];
}

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
  titleVi?: string | null;
  titleEn?: string | null;
  description: string | null;
  descriptionVi?: string | null;
  descriptionEn?: string | null;
  wasteType: string | null;
  severityLevel: number | null;
  latitude: number | null;
  longitude: number | null;
  detailAddress: string | null;
  status: number | null;
  /** Admin verification; only admins can set true. */
  isVerify: boolean;
  /** Admin ban reason; `null`/empty when the report has not been banned. */
  rejectReason: string | null;
  aiVerified: boolean;
  /** LLM recommendation after image/object analysis (nullable until analysis completes). */
  aiRecommendation?: string | null;
  /**
   * Duplicate verification (SHA-256 / pHash). Null until the AI worker writes back.
   * After a check with no hit: duplicateReportId and reason are null; matches is empty.
   */
  duplicateVerification: DuplicateVerification | null;
  createdAt: Date;
  updatedAt: Date;
  distance?: number; // Distance in meters (when searching with location)
  votes: ResourceVoteSummary;
  /**
   * Whether the current user saved this report. Null when the viewer is unknown (unauthenticated).
   */
  saved: boolean | null;
}

/** Organization handling the report, via `report.campaignId` → Campaign → Organization. */
export interface ReportHandledByResponse {
  id: string;
  name: string;
  slug: string;
  logoUrl: string;
  backgroundUrl: string | null;
  contactEmail: string | null;
}

export interface ReportDetailResponse extends ReportResponse {
  mediaFiles: ReportMediaFileResponse[];
  /** Null when the report is not linked to a campaign (or campaign/org is deleted). */
  handledBy: ReportHandledByResponse | null;
}

export interface ReportMediaFileResponse extends MediaMetadataResponse {
  id: string;
  mediaId: string;
  url: string | null;
  type: string | null;
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

/** OpenAPI: `data` for GET /reports/all — ACTIVE status only, no pagination */
export interface ReportsActiveListEnvelopeData {
  reports: ReportDetailResponse[];
}

/** OpenAPI: `data` for background job status */
export interface BackgroundJobsEnvelopeData {
  backgroundJobs: ReportBackgroundJobsStatusResponse;
}
