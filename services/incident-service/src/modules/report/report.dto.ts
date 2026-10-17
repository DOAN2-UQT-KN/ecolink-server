import type { ModerationReasonCode, ReportCategory, RiskFlag, VerificationStatus, WasteType } from "@prisma/client";
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
  /** Legacy (client trước spec 007): CSV, dùng wasteTypes. Xoá ở P10. */
  wasteType?: string;
  category?: ReportCategory;
  wasteTypes?: WasteType[];
  severityLevel?: number;
  latitude: number;
  longitude: number;
  /** Optional human-readable address for the report location. */
  detailAddress?: string;
  images?: CreateReportImageInput[];
  /** Legacy (client trước spec 007): dùng images. Xoá ở P10. */
  imageUrls?: string[];
  /** Legacy, ignored since specs/006 P02 (client-declared capture data is not trusted). */
  mediaCaptures?: MediaCaptureInput[];
}

export interface CreateReportImageInput {
  url: string;
  /** Server-issued capture (P03); absent for gallery uploads. */
  captureId?: string;
}

/** CreateReportRequest after legacy fields are folded into the new shape. */
export interface NormalizedCreateReport {
  category: ReportCategory;
  wasteTypes: WasteType[];
  /** Lower-case CSV kept in `waste_type` so clients before spec 007 still show the waste type. */
  wasteTypeCsv: string | null;
  images: { url: string; captureId: string | null }[];
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
  images?: CreateReportImageInput[];
  /** Legacy (client trước spec 007): dùng images. Xoá ở P10b. */
  imageUrls?: string[];
  /** Legacy, ignored since specs/006 P10. */
  mediaCaptures?: MediaCaptureInput[];
}

/** Body for PUT /api/v1/reports/:id/ban (admin). */
export interface AdminBanReportBody {
  /** Required when banning. */
  rejectReason: string;
  /** Optional moderation reason code (specs/006 P09). */
  reasonCode?: ModerationReasonCode;
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
  /** Admin-only (specs/008): moderation queue filter + risk order; ignored for other viewers. */
  moderation?: "REVIEW" | "REJECT";
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
}

/** One older report and the media pairs that matched it. Stored JSON only. */
export interface DuplicateVerificationGroup {
  duplicateReportId: string;
  matches: DuplicateMediaMatch[];
}

/** Current-report image shown in a duplicate match. Not stored. */
export interface DuplicateNewMedia {
  mediaId: string;
  url: string | null;
}

/** Older-report image shown in a duplicate match. Not stored. */
export interface DuplicateOldMedia {
  duplicateMediaId: string;
  duplicateUrl: string | null;
}

export interface DuplicateVerificationMatchView {
  newMedia: DuplicateNewMedia;
  duplicateMedia: DuplicateOldMedia;
}

/** Group plus report/media summary filled when a report is loaded. */
export interface DuplicateVerificationGroupView {
  duplicateReportId: string;
  title: string | null;
  detailAddress: string | null;
  status: number | null;
  matches: DuplicateVerificationMatchView[];
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
  /** Deprecated free-text CSV; use `wasteTypes`. */
  wasteType: string | null;
  category: ReportCategory;
  wasteTypes: WasteType[];
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
   * Duplicate verification grouped by older report. Null until the AI worker writes back.
   * After a check with no hit: an empty array. Title, address, status, and media URLs
   * are filled when the report is loaded; they are not stored.
   */
  duplicateVerification: DuplicateVerificationGroupView[] | null;
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
  /**
   * Summary of the latest verification: GET /reports/:id (owner and admin), and GET /reports/search
   * for admins only (specs/008). `riskScore` is only ever set for admins.
   */
  latestVerification?: { status: VerificationStatus; flag: RiskFlag | null; riskScore?: number | null } | null;
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
