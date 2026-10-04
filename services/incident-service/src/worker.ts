import "./tracer";
import "dotenv/config";
import prisma from "./config/prisma.client";
/**
 * Initialize all SQS queues and start their polling loops.
 * Queue registration is self-contained: importing register is sufficient.
 */
import { startAllQueues } from "./queue/register";
import {
  startOutboxRelay,
  stopOutboxRelay,
} from "./outbox/outbox-relay.bootstrap";
import {
  startOwnerConfirmationExpiryJob,
  stopOwnerConfirmationExpiryJob,
} from "./modules/organization_application/owner-confirmation-expiry.job";
import {
  startCampaignLifecycleJob,
  stopCampaignLifecycleJob,
} from "./modules/campaign/campaign-lifecycle.job";

console.log("Worker started");
startAllQueues();
startOutboxRelay();
startOwnerConfirmationExpiryJob();
startCampaignLifecycleJob();

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[Worker] received ${signal}, shutting down`);
  stopOwnerConfirmationExpiryJob();
  stopCampaignLifecycleJob();
  await stopOutboxRelay();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
