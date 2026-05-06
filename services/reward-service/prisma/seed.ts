import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { seedMetricMetadata } from "./seeds/metric-metadata.seed";

const prisma = new PrismaClient();

async function main() {
  const rows = [
    { level: 1, name: "easy", maxVolunteers: 10, greenPoints: 10 },
    { level: 2, name: "medium", maxVolunteers: 25, greenPoints: 20 },
    { level: 3, name: "hard", maxVolunteers: 40, greenPoints: 30 },
    { level: 4, name: "very_hard", maxVolunteers: null, greenPoints: 40 },
  ];

  for (const r of rows) {
    await prisma.difficulty.upsert({
      where: { level: r.level },
      create: {
        id: randomUUID(),
        level: r.level,
        name: r.name,
        maxVolunteers: r.maxVolunteers,
        greenPoints: r.greenPoints,
      },
      update: {
        name: r.name,
        maxVolunteers: r.maxVolunteers,
        greenPoints: r.greenPoints,
        deletedAt: null,
      },
    });
  }

  console.log("Reward-service: difficulties seeded.");

  await seedMetricMetadata(prisma);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
