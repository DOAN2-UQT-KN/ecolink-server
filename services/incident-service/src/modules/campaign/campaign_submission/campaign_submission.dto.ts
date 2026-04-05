export interface CreateCampaignSubmissionBody {
  title?: string;
  description?: string;
}

export interface AddSubmissionResultBody {
  title: string;
  description?: string;
  mediaUrls?: string[];
}

export interface ProcessSubmissionBody {
  approved: boolean;
}

export interface SubmissionOneEnvelopeData {
  submission: object;
}

export interface SubmissionsListEnvelopeData {
  submissions: object[];
}

/** Query for GET /campaigns/:id/submissions */
export interface CampaignSubmissionsListQuery {
  status?: number;
  submittedBy?: string;
  /** Case-insensitive substring match on submission title. */
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "updatedAt" | "title";
  sortOrder?: "asc" | "desc";
}

export interface PaginatedSubmissionsEnvelopeData {
  submissions: object[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ResultsListEnvelopeData {
  results: object[];
}

export interface ResultOneEnvelopeData {
  result: object;
}
