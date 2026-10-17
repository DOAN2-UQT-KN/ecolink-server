const postMock = jest.fn();
const nearbyMock = jest.fn();

jest.mock("axios", () => ({ __esModule: true, default: { post: (...a: unknown[]) => postMock(...a) } }));
jest.mock("../checks/nearby-reports", () => ({ findNearbyReports: (...a: unknown[]) => nearbyMock(...a) }));

import { duplicateCheck } from "../checks/duplicate.check";
import type { VerificationContext } from "../checks/check-runner";
import type { ChecksConfig } from "../verification-config.types";

const checksConfig = {
  duplicate: {
    version: "duplicate@2.0.0",
    phashGlobalMax: 6,
    phashCandidateMax: 10,
    candidateRadiusM: 500,
    candidateDays: 7,
    orbMinInliers: 25,
    orbMinInlierRatio: 0.3,
    nearbyRadiusM: 100,
    nearbyHours: 24,
    risk: { phashStrict: 0.9, phashLoose: 0.75, orb: 0.7, internet: 0.85 },
  },
} as ChecksConfig;

const ctx: VerificationContext = {
  report: {
    id: "r1",
    userId: "u1",
    category: "WATERWAY",
    latitude: 10.79,
    longitude: 106.68,
    createdAt: new Date("2026-10-16T08:00:00Z"),
  },
  media: [{ mediaId: "m1", reportMediaFileId: "rmf1", url: "https://x/a.jpg", captureSource: "GALLERY" }],
  attempt: 2,
  checksConfig,
};

const aiResult = (status: string) => ({
  check: "DUPLICATE",
  version: "duplicate@2.0.0",
  status,
  risk: status === "COMPLETED" ? 0.9 : null,
  reasons: status === "COMPLETED" ? ["DUP_NEAR_IMAGE_MATCH"] : [],
  signals: [
    { name: "phash", status: "COMPLETED", risk: 0.9, raw: 4 },
    { name: "orb", status: "SKIPPED", risk: null },
    { name: "internet", status: "NOT_AVAILABLE", risk: null },
  ],
  evidence: { candidates_scanned: 3, match: { report_id: "r-old" } },
  error: status === "FAILED" ? { code: "DOWNLOAD_FAILED", message: "x" } : null,
  duration_ms: 812,
});

describe("duplicateCheck (calls ai-service)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    postMock.mockReset();
    nearbyMock.mockReset().mockResolvedValue([{ reportId: "r-near", distanceM: 40 }]);
    process.env.INTERNAL_AI_API_KEY = "k";
    process.env.AI_SERVICE_URL = "http://ai:3004/";
  });
  afterAll(() => {
    process.env = saved;
  });

  it("posts the snake_case contract with config.version and the abort signal", async () => {
    postMock.mockResolvedValue({ data: aiResult("COMPLETED") });
    const signal = new AbortController().signal;
    await duplicateCheck.run(ctx, signal);

    const [url, body, options] = postMock.mock.calls[0];
    expect(url).toBe("http://ai:3004/internal/v1/verification/duplicate");
    expect(body).toMatchObject({
      report_id: "r1",
      user_id: "u1",
      attempt: 2,
      created_at: "2026-10-16T08:00:00.000Z",
      media: [{ media_id: "m1", report_media_file_id: "rmf1", url: "https://x/a.jpg", capture_source: "GALLERY" }],
      config: { version: "duplicate@2.0.0", phash_global_max: 6, orb_min_inliers: 25, risk: { phash_strict: 0.9 } },
    });
    expect(body.config).not.toHaveProperty("web");
    expect(options).toMatchObject({ headers: { "x-internal-api-key": "k" }, signal });
  });

  it("sends config.web with Ecolink's Cloudinary folders blocked (specs/011)", async () => {
    postMock.mockResolvedValue({ data: aiResult("COMPLETED") });
    process.env.CLOUDINARY_CLOUD_NAME = "eco";
    process.env.CLOUDINARY_ALLOWED_CLOUD_NAMES = "web-eco";
    const web = {
      enabled: true, dailyLimit: 100, maxImages: 10, batchSize: 3, maxCandidates: 5, maxResults: 20,
      callTimeoutMs: 4000, totalTimeoutMs: 8000, fetchTimeoutMs: 2000, fetchMaxBytes: 5_000_000,
      cacheTtlDays: 30, blockedHosts: ["ecolink.example"],
    };
    await duplicateCheck.run(
      { ...ctx, checksConfig: { duplicate: { ...checksConfig.duplicate, web } } as ChecksConfig },
      new AbortController().signal,
    );

    expect(postMock.mock.calls[0][1].config.web).toEqual({
      enabled: true, daily_limit: 100, max_images: 10, batch_size: 3, max_candidates: 5, max_results: 20,
      call_timeout_ms: 4000, total_timeout_ms: 8000, fetch_timeout_ms: 2000, fetch_max_bytes: 5_000_000,
      cache_ttl_days: 30, blocked_hosts: ["ecolink.example"],
      blocked_url_prefixes: ["https://res.cloudinary.com/eco/", "https://res.cloudinary.com/web-eco/"],
    });
  });

  it("maps the result and adds nearby_reports when COMPLETED", async () => {
    postMock.mockResolvedValue({ data: aiResult("COMPLETED") });
    const result = await duplicateCheck.run(ctx, new AbortController().signal);
    expect(result).toMatchObject({ status: "COMPLETED", risk: 0.9, durationMs: 812, reasons: ["DUP_NEAR_IMAGE_MATCH"] });
    expect(result.signals[1]).toEqual({ name: "orb", status: "SKIPPED", risk: null, raw: null });
    expect(result.evidence).toMatchObject({ candidates_scanned: 3, nearby_reports: [{ reportId: "r-near", distanceM: 40 }] });
  });

  it("keeps a FAILED result as-is, without nearby_reports", async () => {
    postMock.mockResolvedValue({ data: aiResult("FAILED") });
    const result = await duplicateCheck.run(ctx, new AbortController().signal);
    expect(result).toMatchObject({ status: "FAILED", error: { code: "DOWNLOAD_FAILED" } });
    expect(result.evidence).not.toHaveProperty("nearby_reports");
    expect(nearbyMock).not.toHaveBeenCalled();
  });

  it("rejects on HTTP errors, bad payloads and a missing key", async () => {
    postMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(duplicateCheck.run(ctx, new AbortController().signal)).rejects.toThrow("ECONNREFUSED");

    postMock.mockResolvedValueOnce({ data: { hello: "world" } });
    await expect(duplicateCheck.run(ctx, new AbortController().signal)).rejects.toThrow(/invalid/);

    delete process.env.INTERNAL_AI_API_KEY;
    await expect(duplicateCheck.run(ctx, new AbortController().signal)).rejects.toThrow(/INTERNAL_AI_API_KEY/);
  });
});
