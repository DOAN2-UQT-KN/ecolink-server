export const FACEBOOK_RECOGNITION_JOB_TYPE =
  "CAMPAIGN_FACEBOOK_RECOGNITION" as const;

export interface RecognizedVolunteerContact {
  name: string;
  email: string | null;
}

export interface CampaignFacebookRecognitionPayload {
  campaignId: string;
  campaignTitle: string;
  recognizedUserIds: string[];
  completedAt: string;
  /** Public image URL (e.g. campaign banner) for Facebook photo post */
  bannerUrl?: string | null;
  description?: string | null;
  /** Checked-in volunteers (name + email from identity) for AI / internal webhook */
  recognizedVolunteers?: RecognizedVolunteerContact[];
}
