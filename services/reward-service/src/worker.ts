import "./tracer";
import "dotenv/config";
import prisma from "./config/prisma.client";
import { startAllQueues, stopAllQueues } from "./queue/register";
import {
  startGreenPointExpiryJob,
  stopGreenPointExpiryJob,
} from "./modules/green-point/green-point-expiry.job";

startAllQueues();
startGreenPointExpiryJob();

console.log("Reward green-point worker started");

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[RewardWorker] received ${signal}, shutting down`);
  stopGreenPointExpiryJob();
  await stopAllQueues();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
