import { BackgroundJobDispatcher } from "@da2/queue";
import { KNOWN_GREEN_POINT_JOB_TYPES } from "../modules/green-point/green-point.types";
import { RewardBackgroundJobStore } from "./reward-background-job-store";
import { RewardSqsQueueFactory } from "./reward-sqs-queue-factory";

const backgroundJobStore = new RewardBackgroundJobStore();
const sqsFactory = new RewardSqsQueueFactory({});

const greenPointQueue = sqsFactory.createQueue(
  "SQS_GREEN_POINT_QUEUE_URL",
  backgroundJobStore,
);

export const backgroundJobDispatcher = new BackgroundJobDispatcher();
for (const jobType of KNOWN_GREEN_POINT_JOB_TYPES) {
  backgroundJobDispatcher.register(jobType, greenPointQueue);
}

export { backgroundJobStore, greenPointQueue };
