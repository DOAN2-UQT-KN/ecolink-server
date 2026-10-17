import { readFileSync } from "node:fs";
import { IT_DB_FILE } from "./it-db-file";

// Runs in every worker BEFORE any test module (and thus before the Prisma
// singleton in config/prisma.client.ts is imported), so DATABASE_URL points at
// the throwaway test DB created in global-setup.
const { databaseUrl } = JSON.parse(readFileSync(IT_DB_FILE, "utf8")) as {
  databaseUrl: string;
};

process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
// Default internal key; individual relay tests point REWARD_SERVICE_URL at the
// in-process mock and reuse this key.
process.env.INTERNAL_REWARD_API_KEY =
  process.env.INTERNAL_REWARD_API_KEY ?? "it-internal-key";
// Tests pin the default report limit (BR-114) whatever a local .env raises it to.
process.env.REPORT_RATE_LIMIT_MAX = "5";
