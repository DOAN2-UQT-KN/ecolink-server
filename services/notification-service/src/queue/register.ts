import { QueueRunner, type QueueRouteConfig } from "@da2/queue";
import { NotificationBackgroundJobStore } from "./background-job-store";
import { NotificationSqsQueueFactory } from "./notification-sqs-queue-factory";
import { NotificationJobType } from "./notification-job.types";
import { NotificationSendWorker } from "./workers/notification-send.worker";

const backgroundJobStore = new NotificationBackgroundJobStore();
const sqsFactory = new NotificationSqsQueueFactory({});

const QUEUE_ROUTES: QueueRouteConfig[] = [
  {
    jobType: NotificationJobType.SEND_NOTIFICATION,
    concurrency: Number(process.env.NOTIFICATION_SEND_CONCURRENCY ?? 1),
    createQueue: () =>
      sqsFactory.createQueue("SQS_NOTIFICATION_QUEUE_URL", backgroundJobStore),
    store: backgroundJobStore,
    createWorkers: (queue, store) => [new NotificationSendWorker(queue, store, {})],
  },
];

const queueRunner = new QueueRunner(QUEUE_ROUTES);

export function startAllQueues(): void {
  queueRunner.startAll();
}

export const backgroundJobDispatcher = queueRunner.dispatcher;
