/**
 * BackgroundJobStore contract.
 *
 * Concrete implementations live in each service (e.g. Prisma-backed store),
 * so this shared package does not depend on any ORM/client types.
 */
export interface BackgroundJobStore {
  /** Persists a durable job record and returns the new job id. */
  createJob(jobType: string, payload: unknown): Promise<string>;

  /**
   * Attempts to transition a job into processing state.
   * Returns false if the job is no longer eligible (e.g. already completed).
   */
  markProcessing(jobId: string, receiveCount: number): Promise<boolean>;

  /** Marks a job completed successfully. */
  markSucceeded(jobId: string): Promise<void>;

  /** Marks a job failed. */
  markFailed(jobId: string): Promise<void>;

  /** Marks a job scheduled to retry (typically back to pending). */
  markRetryScheduled(jobId: string): Promise<void>;

  /** Marks that the job was successfully enqueued to the underlying queue. */
  markEnqueued(jobId: string): Promise<void>;

  /** Marks job failed if enqueue/send to queue did not happen. */
  markFailedWithoutSend(jobId: string): Promise<void>;
}
