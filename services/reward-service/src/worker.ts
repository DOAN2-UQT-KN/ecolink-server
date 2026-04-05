import dotenv from "dotenv";
import prisma from "./config/prisma.client";
import { GreenPointQueueWorker } from "./modules/green-point/green-point-queue.worker";

dotenv.config();

const worker = new GreenPointQueueWorker();

console.log("Reward green-point worker started");

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[RewardWorker] received ${signal}, shutting down`);
  await worker.stop();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

worker.start();
