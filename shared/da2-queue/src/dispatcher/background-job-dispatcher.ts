import type {
  BackgroundJobQueue,
  EnqueueOptions,
} from "../core/background-job-queue.interface";

/**
 * Producer-side dispatcher: given a jobType string, enqueues to the correct queue.
 * At runtime each jobType is registered exactly once.
 */
export class BackgroundJobDispatcher {
  private readonly byType = new Map<string, BackgroundJobQueue>();

  register(jobType: string, queue: BackgroundJobQueue): void {
    if (this.byType.has(jobType)) {
      throw new Error(`Duplicate jobType registration: ${jobType}`);
    }
    this.byType.set(jobType, queue);
  }

  enqueue(
    jobType: string,
    payload: unknown,
    options?: EnqueueOptions,
  ): Promise<void> {
    const queue = this.byType.get(jobType);
    if (!queue) {
      throw new Error(`No queue registered for job type: ${jobType}`);
    }
    return queue.enqueue(jobType, payload, options);
  }
}
