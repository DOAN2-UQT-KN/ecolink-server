import { GreenPointCreditWorker } from "./workers/green-point-credit.worker";
import { backgroundJobStore, greenPointQueue } from "./green-point-queue.bootstrap";

const workers: GreenPointCreditWorker[] = [];
let started = false;

const thresholds = {
  maxRetries: Number(process.env.WORKER_MAX_RECEIVE_COUNT ?? 5),
  retryBaseSeconds: Number(process.env.WORKER_RETRY_BASE_SECONDS ?? 30),
  maxRetryDelaySeconds: Number(
    process.env.WORKER_MAX_RETRY_DELAY_SECONDS ?? 900,
  ),
  visibilityTimeoutSeconds: Number(
    process.env.WORKER_SQS_VISIBILITY_TIMEOUT_SECONDS ?? 120,
  ),
  batchSize: Number(process.env.WORKER_BATCH_SIZE ?? 5),
  waitTimeSeconds: Number(process.env.WORKER_SQS_WAIT_TIME_SECONDS ?? 20),
};

const concurrency = Number(process.env.GREEN_POINT_QUEUE_CONCURRENCY ?? 1);

export function startAllQueues(): void {
  if (started) return;
  started = true;

  for (let i = 0; i < concurrency; i++) {
    const worker = new GreenPointCreditWorker(
      greenPointQueue,
      backgroundJobStore,
      thresholds,
    );
    workers.push(worker);
    worker.start();
  }
  console.log(
    `[reward-service] ${workers.length} green-point queue worker(s) started`,
  );
}

export async function stopAllQueues(): Promise<void> {
  await Promise.all(workers.map((w) => w.stop()));
  workers.length = 0;
  started = false;
}
