import type { CaptureSource, ReportCategory } from "@prisma/client";
import type { ChecksConfig } from "../verification-config.types";
import type { CheckName, CheckResult } from "../verification.types";

/** Everything a check may read; loaded once per attempt by the orchestrator. */
export interface VerificationContext {
  report: {
    id: string;
    userId: string | null;
    category: ReportCategory;
    latitude: number | null;
    longitude: number | null;
    createdAt: Date;
  };
  media: { mediaId: string; reportMediaFileId: string; url: string; captureSource: CaptureSource }[];
  attempt: number;
  checksConfig: ChecksConfig;
}

/**
 * A check only returns a CheckResult; it never writes verification results or calls other
 * internal services (specs/006 FR-009). `signal` aborts when the per-check timeout fires.
 */
export interface CheckRunner {
  name: CheckName;
  /** Full signal list, reported even when skipped / failed / not available. */
  signalNames: readonly string[];
  version(cfg: ChecksConfig): string;
  run(ctx: VerificationContext, signal: AbortSignal): Promise<CheckResult>;
}

export function notAvailableResult(runner: CheckRunner, cfg: ChecksConfig): CheckResult {
  return {
    check: runner.name,
    version: runner.version(cfg),
    status: "NOT_AVAILABLE",
    risk: null,
    reasons: [],
    signals: runner.signalNames.map((name) => ({ name, status: "NOT_AVAILABLE", risk: null })),
    evidence: {},
    durationMs: 0,
  };
}
