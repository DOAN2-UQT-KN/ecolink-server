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

export interface ResultsListEnvelopeData {
  results: object[];
}

export interface ResultOneEnvelopeData {
  result: object;
}
