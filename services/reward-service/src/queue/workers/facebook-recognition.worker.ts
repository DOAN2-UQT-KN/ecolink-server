import { QueueWorker } from "@da2/queue";
import type {
  BackgroundJobEnvelope,
  BackgroundJobQueue,
  QueueThresholdConfig,
} from "@da2/queue";
import { facebookRecognitionService } from "../../modules/facebook-recognition/facebook-recognition.service";
import { FACEBOOK_RECOGNITION_JOB_TYPE } from "../../modules/facebook-recognition/facebook-recognition.types";

const FACEBOOK_RECOGNITION_WORKER_LABEL = "FACEBOOK_RECOGNITION";

export class FacebookRecognitionWorker extends QueueWorker {
  protected readonly jobType = FACEBOOK_RECOGNITION_WORKER_LABEL;

  constructor(
    queue: BackgroundJobQueue,
    store: ConstructorParameters<typeof QueueWorker>[1],
    threshold: QueueThresholdConfig,
  ) {
    super(queue, store, threshold);
  }

  protected jobTypeMatches(messageJobType: string): boolean {
    return messageJobType === FACEBOOK_RECOGNITION_JOB_TYPE;
  }

  protected async process(body: string, _jobId: string): Promise<void> {
    const envelope = JSON.parse(body) as BackgroundJobEnvelope<unknown>;
    if (!envelope?.jobType || typeof envelope.jobType !== "string") {
      throw new Error("Invalid facebook recognition job envelope");
    }
    await facebookRecognitionService.applyQueuedJob(envelope.payload);
  }
}
