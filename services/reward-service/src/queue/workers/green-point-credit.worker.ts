import { QueueWorker } from "@da2/queue";
import type {
  BackgroundJobEnvelope,
  BackgroundJobQueue,
  QueueThresholdConfig,
} from "@da2/queue";
import { KNOWN_GREEN_POINT_JOB_TYPES } from "../../modules/green-point/green-point.types";
import { greenPointService } from "../../modules/green-point/green-point.instances";

/** Log label only; SQS envelopes use concrete strategy jobType strings. */
const GREEN_POINT_WORKER_LABEL = "GREEN_POINT_CREDIT";

export class GreenPointCreditWorker extends QueueWorker {
  protected readonly jobType = GREEN_POINT_WORKER_LABEL;

  constructor(
    queue: BackgroundJobQueue,
    store: ConstructorParameters<typeof QueueWorker>[1],
    threshold: QueueThresholdConfig,
  ) {
    super(queue, store, threshold);
  }

  protected jobTypeMatches(messageJobType: string): boolean {
    return (KNOWN_GREEN_POINT_JOB_TYPES as readonly string[]).includes(
      messageJobType,
    );
  }

  protected async process(body: string, _jobId: string): Promise<void> {
    const envelope = JSON.parse(body) as BackgroundJobEnvelope<unknown>;
    if (!envelope?.jobType || typeof envelope.jobType !== "string") {
      throw new Error("Invalid green point job envelope");
    }

    await greenPointService.applyQueuedJob({
      jobType: envelope.jobType,
      payload: envelope.payload,
    });
  }
}
