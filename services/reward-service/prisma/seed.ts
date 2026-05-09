import { Prisma, PrismaClient } from "@prisma/client";
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

  const voteMilestones = [
    { threshold: 1, points: 1 },
    { threshold: 2, points: 2 },
    { threshold: 5, points: 5 },
    { threshold: 10, points: 10 },
  ];
  for (const m of voteMilestones) {
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "report_vote_green_point_rules"
          (id, threshold, points, "is_active")
        VALUES
          (${randomUUID()}::uuid, ${m.threshold}, ${m.points}, true)
        ON CONFLICT (threshold)
        DO UPDATE SET
          points = EXCLUDED.points,
          "is_active" = true
      `,
    );
  }
  console.log(
    `Reward-service: report vote green point rules seeded (${voteMilestones.length} thresholds).`,
  );

  await seedMetricMetadata(prisma);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
