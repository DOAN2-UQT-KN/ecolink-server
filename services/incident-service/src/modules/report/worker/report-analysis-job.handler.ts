import {
  AnalyzeReportJobPayload,
  BackgroundJobEnvelope,
  BackgroundJobType,
} from "../../background-job/background-job.types";
import type { BackgroundJobMessageHandler } from "../../background-job/worker/background-job-handler.types";
import { reportAiAnalysisService } from "../report-ai-analysis.service";

function parseAnalyzeReportPayload(body: string): {
  jobId: string;
  payload: AnalyzeReportJobPayload;
} {
  let envelope: unknown;

  try {
    envelope = JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON message body");
  }

  const parsedEnvelope = envelope as Partial<
    BackgroundJobEnvelope<AnalyzeReportJobPayload>
  >;

  if (typeof parsedEnvelope.jobId !== "string" || !parsedEnvelope.jobId) {
    throw new Error("Missing jobId in message envelope");
  }

  if (parsedEnvelope.jobType !== BackgroundJobType.ANALYZE_REPORT) {
    throw new Error(
      `Expected ${BackgroundJobType.ANALYZE_REPORT}, got ${String(parsedEnvelope.jobType)}`,
    );
  }

  const payload = parsedEnvelope.payload as Partial<AnalyzeReportJobPayload>;

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

  return {
    jobId: parsedEnvelope.jobId,
    payload: {
      reportId: payload.reportId,
      reportMediaFileIds,
    },
  };
}

export const reportAnalysisJobHandler: BackgroundJobMessageHandler = {
  jobType: BackgroundJobType.ANALYZE_REPORT,

  parseAndPrepare(body: string) {
    const { jobId, payload } = parseAnalyzeReportPayload(body);
    return {
      jobId,
      run: () =>
        reportAiAnalysisService.analyzeReport(
          payload.reportId,
          payload.reportMediaFileIds,
        ),
    };
  },
};
