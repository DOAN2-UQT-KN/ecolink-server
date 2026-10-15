import type { BackgroundJobStore } from "@da2/queue";

/**
 * Store for queues fed by the outbox relay. Those messages have no `background_jobs` row, so the
 * default store would make QueueWorker skip them; de-duplication lives in the consumer instead
 * (e.g. unique (reportId, attempt) for report verification — specs/006 research R3).
 */
export class OutboxDeliveredJobStore implements BackgroundJobStore {
  async createJob(): Promise<string> {
    throw new Error("outbox-delivered queues are not enqueued through the dispatcher");
  }

  async markProcessing(): Promise<boolean> {
    return true;
  }

  async markSucceeded(): Promise<void> {}
  async markFailed(): Promise<void> {}
  async markRetryScheduled(): Promise<void> {}
  async markEnqueued(): Promise<void> {}
  async markFailedWithoutSend(): Promise<void> {}
}
