import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { seedMetricMetadata } from "./seeds/metric-metadata.seed";

const prisma = new PrismaClient();

async function main() {
  const rows = [
    { level: 1, name: "easy", maxVolunteers: 10, suggestedMinVolunteers: 5, greenPoints: 10 },
    { level: 2, name: "medium", maxVolunteers: 25, suggestedMinVolunteers: 10, greenPoints: 20 },
    { level: 3, name: "hard", maxVolunteers: 40, suggestedMinVolunteers: 20, greenPoints: 30 },
    { level: 4, name: "very_hard", maxVolunteers: null, suggestedMinVolunteers: 30, greenPoints: 40 },
  ];

  for (const r of rows) {
    await prisma.difficulty.upsert({
      where: { level: r.level },
      create: {
        id: randomUUID(),
        level: r.level,
        name: r.name,
        maxVolunteers: r.maxVolunteers,
        suggestedMinVolunteers: r.suggestedMinVolunteers,
        greenPoints: r.greenPoints,
      },
      update: {
        name: r.name,
        maxVolunteers: r.maxVolunteers,
        suggestedMinVolunteers: r.suggestedMinVolunteers,
        greenPoints: r.greenPoints,
        deletedAt: null,
      },
    });
  }

  console.log("Reward-service: difficulties seeded.");

  const baseReportPoint = 5;
  const reportMilestoneThresholds = [1, 2, 5, 10];
  const existingPointRules = await prisma.gamificationPointRules.findFirst({
    where: { isActive: true },
    orderBy: { effectiveFrom: "desc" },
  });
  if (!existingPointRules) {
    await prisma.gamificationPointRules.create({
      data: {
        id: randomUUID(),
        baseReportPoint,
        reportMilestoneThresholds,
        isActive: true,
      },
    });
    console.log(
      "Reward-service: gamification point rules seeded (citizen report vote milestones).",
    );
  }

  await seedMetricMetadata(prisma);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
