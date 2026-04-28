import { QueueRunner, QueueRouteConfig } from "@da2/queue";
import { ReportSqsQueueFactory } from "./report-sqs-queue-factory";
import prisma from "../config/prisma.client";
import { ReportAnalysisWorker } from "./worker/report-analysis-worker";
import { ReportJobType } from "../constants/job-type.enum";
import BackgroundJobStore from "./background-job-store";

// ─── Shared store (injects Prisma once, reusable across routes) ───────────────

const backgroundJobStore = new BackgroundJobStore(prisma);

// ─── Route declarations ────────────────────────────────────────────────────────

const sqsFactory = new ReportSqsQueueFactory({});

const QUEUE_ROUTES: QueueRouteConfig[] = [
  {
    jobType: ReportJobType.ANALYZE_REPORT,
    concurrency: Number(process.env.ANALYZE_REPORT_CONCURRENCY ?? 1),
    createQueue: () =>
      sqsFactory.createQueue("SQS_REPORT_ANALYSIS_QUEUE_URL", backgroundJobStore),
    store: backgroundJobStore,
    createWorkers: (queue, store) => [
      new ReportAnalysisWorker(queue, store, {}),
    ],
  },
  // Add new routes here — no other code changes needed.
  // Example:
  // {
  //   jobType: ReportJobType.SEND_WEBHOOK,
  //   concurrency: Number(process.env.WEBHOOK_CONCURRENCY ?? 1),
  //   createQueue: () => sqsFactory.createQueue("SQS_WEBHOOK_QUEUE_URL", backgroundJobStore),
  //   store: backgroundJobStore,
  //   createWorkers: (queue, store) => [new WebhookWorker(queue, store, {})],
  // },
];

// ─── Queue runner ─────────────────────────────────────────────────────────────

const queueRunner = new QueueRunner(QUEUE_ROUTES);

/**
 * Start all registered polling loops.
 * Call ONLY from the dedicated worker entry point.
 */
export function startAllQueues(): void {
  console.log("Starting all queues");
  queueRunner.startAll();
}

/** Shared dispatcher — used by the API to enqueue. */
export const backgroundJobDispatcher = queueRunner.dispatcher;