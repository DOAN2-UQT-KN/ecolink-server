/**
 * Versioned verification config (specs/006, plan P04): migration seed, one active
 * version per key, atomic activation and the in-memory cache.
 * verification_configs is NOT truncated by resetTables; tests restore the seed.
 */
import { prisma } from "./setup/test-db";
import {
  activateConfigVersion,
  createVerificationConfigService,
  verificationConfigService,
} from "../modules/verification/verification-config.service";

const SEED_ENGINE = "rules@3.0.0";

describe("[it] verification config (P04)", () => {
  afterAll(async () => {
    // Restore the migration seed as the active engine version.
    await prisma.verificationConfig.updateMany({ where: { key: "engine" }, data: { isActive: false } });
    await prisma.verificationConfig.deleteMany({ where: { key: "engine", version: { not: SEED_ENGINE } } });
    await prisma.verificationConfig.update({
      where: { key_version: { key: "engine", version: SEED_ENGINE } },
      data: { isActive: true },
    });
    await prisma.$disconnect();
  });

  beforeEach(() => verificationConfigService.clearCache());

  it("serves the migration seed", async () => {
    const engine = await verificationConfigService.get("engine");
    expect(engine.version).toBe(SEED_ENGINE);
    expect(engine.value.weights).toEqual({ DUPLICATE: 0.6, TRUST: 0.4, CONTEXT: 0.1 });

    const pipeline = await verificationConfigService.get("pipeline");
    expect(pipeline.version).toBe("2.4.0");
    expect(pipeline.value).toEqual({ maxAttempts: 3, checkTimeoutMs: 20000 });

    const checks = await verificationConfigService.get("checks");
    expect(checks.version).toBe("checks@1.2.0");
    expect(checks.value.duplicate.version).toBe("duplicate@2.1.0");
    expect(checks.value.duplicate.web).toMatchObject({ enabled: false, maxImages: 10, batchSize: 3 });
    expect(checks.value.context).toEqual({ version: "context@2.0.0", queryTimeoutMs: 1000, suggestTimeoutMs: 2000 });

    const rules = await verificationConfigService.get("category-rules");
    expect(rules.version).toBe("category-rules@2.0.0");
    expect(Object.keys(rules.value.rules)).toHaveLength(12);
    expect(rules.value.rules.MARKET).toEqual({
      kind: "NEAR_FEATURE",
      classes: ["market"],
      maxDistanceM: 100,
      missRisk: 0.35,
      requireCoverage: true,
    });
    expect(rules.value.rules.DRAIN).toEqual({ kind: "NONE" });
    expect(rules.value.coverage).toEqual({ radiusM: 300, minPoi: 15 });
  });

  it("rejects a second active row for the same key", async () => {
    await expect(
      prisma.verificationConfig.create({
        data: { key: "engine", version: "rules@dup", value: {}, isActive: true },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("activates a new version atomically and refuses an existing one", async () => {
    const seed = await verificationConfigService.get("engine");
    const next = { ...seed.value, thresholds: { review: 0.35, reject: 0.75 } };

    await expect(activateConfigVersion(prisma, "engine", "rules@3.1.0", next)).resolves.toEqual({
      previous: SEED_ENGINE,
      current: "rules@3.1.0",
    });
    await expect(activateConfigVersion(prisma, "engine", "rules@3.1.0", next)).rejects.toThrow(/already exists/);

    verificationConfigService.clearCache();
    const active = await verificationConfigService.get("engine");
    expect(active.version).toBe("rules@3.1.0");
    expect(active.value.thresholds).toEqual({ review: 0.35, reject: 0.75 });
    expect(await prisma.verificationConfig.count({ where: { key: "engine", isActive: true } })).toBe(1);
  });

  it("caches reads per key", async () => {
    const spy = jest.spyOn(prisma.verificationConfig, "findFirst");
    const service = createVerificationConfigService(prisma);
    await service.get("pipeline");
    await service.get("pipeline");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("fails loudly when a key has no active version", async () => {
    const service = createVerificationConfigService(prisma);
    await prisma.verificationConfig.updateMany({ where: { key: "pipeline" }, data: { isActive: false } });
    try {
      await expect(service.get("pipeline")).rejects.toThrow("verification config 'pipeline' has no active version");
    } finally {
      await prisma.verificationConfig.update({
        where: { key_version: { key: "pipeline", version: "2.4.0" } },
        data: { isActive: true },
      });
    }
  });
});
