export enum BackgroundJobType {
  ANALYZE_REPORT = "ANALYZE_REPORT",
}

export interface AnalyzeReportJobPayload {
  reportId: string;
  mediaFiles: string[];
}

export interface BackgroundJobEnvelope<TPayload = unknown> {
  jobId: string;
  version: 1;
  jobType: BackgroundJobType;
  createdAt: string;
  payload: TPayload;
}

export interface ReceivedBackgroundJob {
  messageId: string;
  receiptHandle: string;
  body: string;
  receiveCount: number;
}
