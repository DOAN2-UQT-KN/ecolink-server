import type { PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";
import type { ConfigValueByKey, EngineConfig, VerificationConfigKey } from "./verification-config.types";

export interface VersionedConfig<K extends VerificationConfigKey> {
  version: string;
  value: ConfigValueByKey[K];
}

const cacheTtlMs = (): number => Number(process.env.VERIFICATION_CONFIG_CACHE_MS ?? 60_000);

// shortcut: chỉ kiểm engine; thêm kiểm cho checks/category-rules khi có giao diện sửa config.
function assertEngineConfig(value: EngineConfig): void {
  const w = value?.weights;
  const t = value?.thresholds;
  const weightsOk = !!w && [w.DUPLICATE, w.TRUST, w.CONTEXT].every((x) => typeof x === "number" && x >= 0);
  const thresholdsOk = !!t && 0 <= t.review && t.review < t.reject && t.reject <= 1;
  if (!weightsOk || !thresholdsOk) throw new Error("verification config 'engine' is malformed");
}

export function createVerificationConfigService(db: Pick<PrismaClient, "verificationConfig">) {
  const cache = new Map<VerificationConfigKey, { at: number; entry: VersionedConfig<VerificationConfigKey> }>();

  return {
    /** Active version of a config key; cached in memory for VERIFICATION_CONFIG_CACHE_MS (default 60 s). */
    async get<K extends VerificationConfigKey>(key: K): Promise<VersionedConfig<K>> {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < cacheTtlMs()) return hit.entry as VersionedConfig<K>;

      const row = await db.verificationConfig.findFirst({ where: { key, isActive: true } });
      if (!row) throw new Error(`verification config '${key}' has no active version`);

      const entry = { version: row.version, value: row.value as unknown as ConfigValueByKey[K] };
      if (key === "engine") assertEngineConfig(entry.value as EngineConfig);
      cache.set(key, { at: Date.now(), entry });
      return entry;
    },

    clearCache(): void {
      cache.clear();
    },
  };
}

export const verificationConfigService = createVerificationConfigService(prisma);

/**
 * Insert a new version of `key` and make it the only active one, atomically.
 * Returns the previously active version (null if none). Refuses an existing (key, version).
 */
export async function activateConfigVersion(
  db: PrismaClient,
  key: VerificationConfigKey,
  version: string,
  value: unknown,
): Promise<{ previous: string | null; current: string }> {
  return db.$transaction(async (tx) => {
    const exists = await tx.verificationConfig.findUnique({ where: { key_version: { key, version } } });
    if (exists) throw new Error(`verification config '${key}' version '${version}' already exists`);

    const previous = await tx.verificationConfig.findFirst({ where: { key, isActive: true } });
    if (previous) await tx.verificationConfig.update({ where: { id: previous.id }, data: { isActive: false } });
    await tx.verificationConfig.create({ data: { key, version, value: value as object, isActive: true } });
    return { previous: previous?.version ?? null, current: version };
  });
}
