// Last step of `npm run osm:import` (scripts/osm/import.sh): swap in the new OSM context table.
// Usage: ts-node scripts/osm/finalize.ts <data timestamp, ISO 8601>
import prisma from "../../src/config/prisma.client";
import { finalizeImport } from "../../src/modules/verification/geo/osm-import";

async function main(): Promise<void> {
  const dataAt = new Date(process.argv[2] ?? "");
  if (Number.isNaN(dataAt.getTime())) {
    console.error("usage: finalize.ts <data timestamp, ISO 8601>");
    process.exit(1);
  }
  const counts = await finalizeImport(prisma, dataAt);
  console.log(`[osm] active import of ${dataAt.toISOString()}:`, counts);
}

main()
  .catch((err) => {
    console.error("[osm] import refused:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
