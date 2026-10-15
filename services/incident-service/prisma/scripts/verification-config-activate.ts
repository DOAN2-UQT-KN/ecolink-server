// Activate a new version of a verification config key (specs/006 research R6).
// Run with:
//   npx ts-node -r tsconfig-paths/register prisma/scripts/verification-config-activate.ts <key> <version> <file.json>
// Example:
//   ... engine rules@3.1.0 ./engine-rules-3.1.0.json
// Workers pick the change up within VERIFICATION_CONFIG_CACHE_MS (default 60 s).
import { readFileSync } from "node:fs";
import prisma from "../../src/config/prisma.client";
import { activateConfigVersion } from "../../src/modules/verification/verification-config.service";
import type { VerificationConfigKey } from "../../src/modules/verification/verification-config.types";

const KEYS: VerificationConfigKey[] = ["pipeline", "engine", "checks", "category-rules"];

async function main(): Promise<void> {
  const [key, version, file] = process.argv.slice(2);
  if (!KEYS.includes(key as VerificationConfigKey) || !version || !file) {
    console.error(`usage: verification-config-activate.ts <${KEYS.join("|")}> <version> <file.json>`);
    process.exit(1);
  }
  const value = JSON.parse(readFileSync(file, "utf8"));
  const { previous, current } = await activateConfigVersion(prisma, key as VerificationConfigKey, version, value);
  console.log(`${key}: ${previous ?? "(none)"} -> ${current}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
