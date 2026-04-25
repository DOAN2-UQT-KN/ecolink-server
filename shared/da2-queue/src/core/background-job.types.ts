export interface BackgroundJobEnvelope<TPayload = unknown> {
  jobId: string;
  version: 1;
  jobType: string;
  createdAt: string;
  payload: TPayload;
}
