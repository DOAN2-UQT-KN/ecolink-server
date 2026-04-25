import { QueueWorker } from "@da2/queue";
import type { BackgroundJobQueue, BackgroundJobEnvelope } from "@da2/queue";
import type { QueueThresholdConfig } from "@da2/queue";
import { ReportJobType } from "../../../constants/job-type.enum";
import { reportAiAnalysisService } from "../report-ai-analysis.service";

interface AnalyzeReportPayload {
  reportId: string;
  reportMediaFileIds: string[];
}

export class ReportAnalysisWorker extends QueueWorker {
  protected readonly jobType = ReportJobType.ANALYZE_REPORT;

  constructor(
    queue: BackgroundJobQueue,
    store: ConstructorParameters<typeof QueueWorker>[1],
    threshold: QueueThresholdConfig,
  ) {
    super(queue, store, threshold);
  }

  protected override async process(body: string, _jobId: string): Promise<void> {
    const envelope = JSON.parse(body) as BackgroundJobEnvelope<AnalyzeReportPayload>;
    const payload = envelope.payload;

    if (
      !payload ||
      typeof payload.reportId !== "string" ||
      !Array.isArray(payload.reportMediaFileIds)
    ) {
      throw new Error("Invalid report analysis payload");
    }

    const reportMediaFileIds = payload.reportMediaFileIds.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );

    if (reportMediaFileIds.length === 0) {
      throw new Error("Report analysis payload has no report media file IDs");
    }

    await reportAiAnalysisService.analyzeReport(payload.reportId, reportMediaFileIds);
  }
}
