import type { BackgroundJobQueue } from "../core/background-job-queue.interface";
import type { BackgroundJobStore } from "../core/background-job-store";
import type { QueueWorker, QueueThresholdConfig } from "../core/queue-worker";

export interface QueueRouteConfig {
  /** Matches the worker.jobType string value. */
  jobType: string;
  /**
   * Number of concurrent worker instances for this route.
   * Each polls the same queue; SQS distributes messages across them.
   */
  concurrency?: number;
  /** Override threshold for this route only. */
  thresholds?: QueueThresholdConfig;
  /**
   * Creates the BackgroundJobQueue for this route.
   * Called once during route registration.
   */
  createQueue: () => BackgroundJobQueue;
  /**
   * BackgroundJobStore for this route's job types.
   * Passed to workers and used by SqsBackgroundJobQueue for DB lifecycle.
   */
  store: BackgroundJobStore;
  /**
   * Given the created queue and store, produce one or more workers.
   */
  createWorkers: (queue: BackgroundJobQueue, store: BackgroundJobStore) => QueueWorker[];
}
