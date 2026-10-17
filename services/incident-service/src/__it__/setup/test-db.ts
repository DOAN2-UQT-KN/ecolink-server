import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";

export { prisma };

/** Wipe the tables the outbox tests touch so each test starts clean. */
export async function resetTables(): Promise<void> {
  await prisma.$executeRaw(
    Prisma.sql`TRUNCATE TABLE "outbox_events", "verification_checks", "report_verifications", "reports" RESTART IDENTITY CASCADE`,
  );
}
