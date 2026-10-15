import axios from "axios";
import type { ReasonCode } from "../../../constants/report-verification";
import type { CheckResult, CheckStatus, Signal } from "../verification.types";
import type { CheckRunner, VerificationContext } from "./check-runner";
import { findNearbyReports } from "./nearby-reports";

/** CheckResult as ai-service returns it (snake_case, contracts/internal-duplicate-check.md). */
interface AiCheckResult {
  check: "DUPLICATE";
  version: string;
  status: CheckStatus;
  risk: number | null;
  reasons: string[];
  signals: { name: string; status: CheckStatus; risk: number | null; raw?: number | null }[];
  evidence: Record<string, unknown>;
  error?: { code: string; message: string } | null;
  duration_ms: number;
}

function requestBody(ctx: VerificationContext) {
  const cfg = ctx.checksConfig.duplicate;
  return {
    report_id: ctx.report.id,
    user_id: ctx.report.userId,
    attempt: ctx.attempt,
    latitude: ctx.report.latitude,
    longitude: ctx.report.longitude,
    created_at: ctx.report.createdAt.toISOString(),
    category: ctx.report.category,
    media: ctx.media.map((m) => ({
      media_id: m.mediaId,
      report_media_file_id: m.reportMediaFileId,
      url: m.url,
    })),
    config: {
      version: cfg.version,
      phash_global_max: cfg.phashGlobalMax,
      phash_candidate_max: cfg.phashCandidateMax,
      candidate_radius_m: cfg.candidateRadiusM,
      candidate_days: cfg.candidateDays,
      orb_min_inliers: cfg.orbMinInliers,
      orb_min_inlier_ratio: cfg.orbMinInlierRatio,
      risk: {
        phash_strict: cfg.risk.phashStrict,
        phash_loose: cfg.risk.phashLoose,
        orb: cfg.risk.orb,
        internet: cfg.risk.internet,
      },
    },
  };
}

function toCheckResult(body: AiCheckResult): CheckResult {
  if (!body || body.check !== "DUPLICATE" || !Array.isArray(body.signals)) {
    throw new Error("ai-service returned an invalid DuplicateCheck result");
  }
  return {
    check: "DUPLICATE",
    version: body.version,
    status: body.status,
    risk: body.risk,
    reasons: body.reasons as ReasonCode[],
    signals: body.signals.map((s): Signal => ({ name: s.name, status: s.status, risk: s.risk, raw: s.raw ?? null })),
    evidence: body.evidence ?? {},
    ...(body.error ? { error: body.error } : {}),
    durationMs: body.duration_ms,
  };
}

/**
 * Image duplicate check, computed by ai-service (specs/006 P06). Errors are thrown;
 * runCheckWithTimeout turns them (and the 10 s timeout, via `signal`) into FAILED.
 */
export const duplicateCheck: CheckRunner = {
  name: "DUPLICATE",
  signalNames: ["phash", "orb", "internet"],
  version: (cfg) => cfg.duplicate.version,
  async run(ctx, signal) {
    const key = process.env.INTERNAL_AI_API_KEY?.trim();
    if (!key) throw new Error("INTERNAL_AI_API_KEY is not configured");
    const base = (process.env.AI_SERVICE_URL || "http://localhost:3004").replace(/\/$/, "");

    const { data } = await axios.post<AiCheckResult>(
      `${base}/internal/v1/verification/duplicate`,
      requestBody(ctx),
      { headers: { "x-internal-api-key": key }, signal },
    );
    const result = toCheckResult(data);
    if (result.status === "COMPLETED") {
      result.evidence = { ...result.evidence, nearby_reports: await findNearbyReports(ctx) };
    }
    return result;
  },
};
