// Request DTOs
export interface CreateReportRequest {
  title: string;
  description?: string;
  wasteType?: string;
  severityLevel?: number;
  latitude: number;
  longitude: number;
  imageUrls: string[]; // Array of image URLs
}

export interface UpdateReportRequest {
  title?: string;
  description?: string;
  wasteType?: string;
  severityLevel?: number;
  latitude?: number;
  longitude?: number;
}

export interface AddReportImagesRequest {
  imageUrls: string[];
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

// Response DTOs
export interface ReportResponse {
  id: string;
  userId: string | null;
  title: string | null;
  description: string | null;
  wasteType: string | null;
  severityLevel: number | null;
  latitude: number | null;
  longitude: number | null;
  status: number | null;
  aiVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  distance?: number; // Distance in meters (when searching with location)
}

export interface ReportDetailResponse extends ReportResponse {
  mediaFiles: ReportMediaFileResponse[];
}

export interface ReportMediaFileResponse {
  id: string;
  mediaId: string;
  url: string | null;
  stage: string | null;
  uploadedBy: string | null;
  createdAt: Date;
}

// Pagination response
export interface PaginatedReportsResponse {
  reports: ReportResponse[];
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

/** OpenAPI: `data` for GET /reports/my */
export interface ReportsListEnvelopeData {
  reports: ReportResponse[];
}

/** OpenAPI: `data` for background job status */
export interface BackgroundJobsEnvelopeData {
  backgroundJobs: ReportBackgroundJobsStatusResponse;
}
