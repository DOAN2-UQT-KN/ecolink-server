import { QueueWorker } from "@da2/queue";
import type { BackgroundJobQueue, BackgroundJobEnvelope } from "@da2/queue";
import type { QueueThresholdConfig } from "@da2/queue";
import { OutboxEventType } from "../../outbox/outbox.types";
import { verificationOrchestrator } from "../../modules/verification/verification.orchestrator";

interface ReportSubmittedPayload {
  reportId?: unknown;
  attempt?: unknown;
}

/** Consumes REPORT_SUBMITTED from the report-verification queue (specs/006 P05). */
export class ReportVerificationWorker extends QueueWorker {
  protected readonly jobType = OutboxEventType.REPORT_SUBMITTED;

  constructor(
    queue: BackgroundJobQueue,
    store: ConstructorParameters<typeof QueueWorker>[1],
    threshold: QueueThresholdConfig,
  ) {
    super(queue, store, threshold);
  }

  protected override async process(body: string, _jobId: string): Promise<void> {
    const envelope = JSON.parse(body) as BackgroundJobEnvelope<ReportSubmittedPayload>;
    const payload = envelope.payload ?? {};
    if (typeof payload.reportId !== "string" || payload.reportId.length === 0) {
      throw new Error("Invalid REPORT_SUBMITTED payload: reportId");
    }
    const attempt = payload.attempt === undefined ? 1 : payload.attempt;
    if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
      throw new Error("Invalid REPORT_SUBMITTED payload: attempt");
    }
    await verificationOrchestrator.handle({ reportId: payload.reportId, attempt });
  }
}
