import { backgroundJobRepository } from "../../background-job/background-job.repository";
import {
  AnalyzeReportJobPayload,
  BackgroundJobType,
} from "../../background-job/background-job.types";

export class ReportAnalysisQueueService {
  async enqueueAnalysis(reportId: string, mediaFiles: string[]): Promise<void> {
    const payload: AnalyzeReportJobPayload = {
      reportId,
      mediaFiles,
    };

    await backgroundJobRepository.enqueue(
      BackgroundJobType.ANALYZE_REPORT,
      payload,
    );
  }

  async reenqueueAnalysis(reportId: string, mediaFiles: string[]): Promise<void> {
    await backgroundJobRepository.cancelPendingAnalyzeJobs(reportId);
    await this.enqueueAnalysis(reportId, mediaFiles);
  }
}

export const reportAnalysisQueueService = new ReportAnalysisQueueService();
