import { BackgroundJobType } from "../background-job.types";

/**
 * One implementation per {@link BackgroundJobType}. The orchestrator selects by envelope.jobType.
 */
export interface BackgroundJobMessageHandler {
  readonly jobType: BackgroundJobType;

  /**
   * Validate the full message body and return work to run after markProcessing succeeds.
   */
    parseAndPrepare(body: string): {
    jobId: string;
    run: () => Promise<void>;
  };
}
