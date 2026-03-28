import dotenv from "dotenv";
import prisma from "./config/prisma.client";
import { BackgroundJobOrchestratorWorker } from "./modules/background-job/worker/background-job-orchestrator.worker";
import { reportAnalysisJobHandler } from "./modules/report/worker/report-analysis-job.handler";

dotenv.config();

const worker = new BackgroundJobOrchestratorWorker([reportAnalysisJobHandler]);

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[Worker] received ${signal}, shutting down`);
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
