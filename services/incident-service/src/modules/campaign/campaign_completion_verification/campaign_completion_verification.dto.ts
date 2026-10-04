/** 1 = clean, -1 = not clean; 0 = cleared. */
export type CampaignCompletionVerificationValue = 1 | -1 | 0;

export interface CampaignCompletionVerificationSummary {
  cleanCount: number;
  notCleanCount: number;
  myVerification: number | null;
  /** Spec 5.1: ≥ 30% "not clean" out of ≥ 5 answers; the admin should look twice. */
  flagged: boolean;
}

export function defaultCampaignCompletionVerificationSummary(
  viewerUserId?: string | null,
): CampaignCompletionVerificationSummary {
  return {
    cleanCount: 0,
    notCleanCount: 0,
    myVerification: viewerUserId != null ? 0 : null,
    flagged: false,
  };
}

export interface SubmitCampaignCompletionVerificationBody {
  value: 1 | -1;
}

export interface CampaignCompletionVerificationActionResponse {
  campaignId: string;
  value: number;
}
