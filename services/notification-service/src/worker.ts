import dotenv from "dotenv";
import { prisma } from "./lib/prisma";
import { startAllQueues } from "./queue/register";

dotenv.config();

startAllQueues();

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[Notification worker] received ${signal}, shutting down`);
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

