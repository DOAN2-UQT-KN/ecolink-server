const findEvidenceMock = jest.fn();
jest.mock("../geo/geo-context.service", () => ({
  findEvidence: (...a: unknown[]) => findEvidenceMock(...a),
  geoDeps: () => ({}),
}));
jest.mock("../verification-config.service", () => ({
  verificationConfigService: {
    get: jest.fn().mockResolvedValue({
      version: "category-rules@1.0.0",
      value: {
        MARKET: { kind: "NEARBY_PLACE", keywords: ["chợ"], maxDistanceM: 150, missRisk: 0.5 },
        DRAIN: { kind: "NONE" },
      },
    }),
  },
}));

import { contextCheck } from "../checks/context.check";
import type { VerificationContext } from "../checks/check-runner";
import type { ChecksConfig } from "../verification-config.types";

const cfg = { context: { version: "context@1.0.0", goongTimeoutMs: 3000, cacheTtlDays: 30, suggestTimeoutMs: 2000 } } as ChecksConfig;
const ctx = (over: Partial<VerificationContext["report"]> = {}): VerificationContext => ({
  report: { id: "r1", userId: "u1", category: "MARKET", latitude: 10.77, longitude: 106.69, createdAt: new Date(), ...over },
  media: [],
  attempt: 1,
  checksConfig: cfg,
});
const evidence = (distanceM: number) => ({
  evidence: [{ name: "Chợ Bến Thành", keyword: "chợ", distanceM, source: "goong_place" }],
  goongCalls: 2,
  cacheHit: false,
});
const run = (c: VerificationContext) => contextCheck.run(c, new AbortController().signal);

describe("contextCheck", () => {
  const saved = process.env.CONTEXT_CHECK_ENABLED;
  beforeEach(() => {
    process.env.CONTEXT_CHECK_ENABLED = "true";
    findEvidenceMock.mockReset();
  });
  afterAll(() => {
    process.env.CONTEXT_CHECK_ENABLED = saved;
  });

  it("is NOT_AVAILABLE while disabled", async () => {
    process.env.CONTEXT_CHECK_ENABLED = "false";
    expect((await run(ctx())).status).toBe("NOT_AVAILABLE");
  });

  it("skips categories without a rule, without calling Goong", async () => {
    const r = await run(ctx({ category: "DRAIN" }));
    expect(r).toMatchObject({ status: "SKIPPED", risk: null, signals: [{ name: "category_fit", status: "SKIPPED" }] });
    expect(findEvidenceMock).not.toHaveBeenCalled();
  });

  it("skips reports without a location", async () => {
    expect((await run(ctx({ latitude: null }))).status).toBe("SKIPPED");
  });

  it("FIT -> risk 0", async () => {
    findEvidenceMock.mockResolvedValue(evidence(120));
    const r = await run(ctx());
    expect(r).toMatchObject({ status: "COMPLETED", risk: 0, reasons: [] });
    expect(r.evidence).toMatchObject({ verdict: "FIT", goongCalls: 2, cacheHit: false, rulesVersion: "category-rules@1.0.0" });
  });

  it("MISMATCH -> missRisk, reason and the nearest place", async () => {
    findEvidenceMock.mockResolvedValue(evidence(900));
    const r = await run(ctx());
    expect(r).toMatchObject({ status: "COMPLETED", risk: 0.5, reasons: ["CTX_CATEGORY_LOCATION_MISMATCH"] });
    expect(r.evidence).toMatchObject({ verdict: "MISMATCH", nearest: { name: "Chợ Bến Thành", distance_m: 900 } });
    expect(r.signals[0]).toMatchObject({ status: "COMPLETED", risk: 0.5, raw: 900 });
  });

  it("propagates Goong errors (runCheckWithTimeout turns them into FAILED)", async () => {
    findEvidenceMock.mockRejectedValue(new Error("OVER_QUERY_LIMIT"));
    await expect(run(ctx())).rejects.toThrow("OVER_QUERY_LIMIT");
  });
});
