import type { ReasonCode } from "../../constants/report-verification";
import type { EngineConfig } from "./verification-config.types";
import type { Assessment, CheckName, CheckResult, RiskFlag } from "./verification.types";

/** No check produced a score; the orchestrator treats the attempt as FAILED and retries. */
export class NoCompletedCheckError extends Error {
  constructor() {
    super("no verification check completed");
    this.name = "NoCompletedCheckError";
  }
}

const FLAG_RANK: Record<RiskFlag, number> = { ACCEPT: 0, REVIEW: 1, REJECT: 2 };
const CHECK_ORDER: CheckName[] = ["DUPLICATE", "TRUST", "CONTEXT"];

const scored = (r: CheckResult): boolean => r.status === "COMPLETED" && r.risk !== null;

/**
 * Pure function: same results + config always give the same assessment.
 * Layer 1 = weighted mean over completed checks (re-normalised, so missing checks don't lower the score).
 * Layer 2 = guard: a failed DuplicateCheck can never be auto-accepted.
 */
export function assess(results: CheckResult[], cfg: EngineConfig, engineVersion: string): Assessment {
  const completed = results.filter(scored);
  if (completed.length === 0) throw new NoCompletedCheckError();

  let weighted = 0;
  let totalWeight = 0;
  for (const r of completed) {
    const w = cfg.weights[r.check] ?? 0;
    weighted += w * (r.risk as number);
    totalWeight += w;
  }
  const score = totalWeight > 0 ? weighted / totalWeight : 0;

  let flag: RiskFlag =
    score < cfg.thresholds.review ? "ACCEPT" : score < cfg.thresholds.reject ? "REVIEW" : "REJECT";

  const engineReasons: ReasonCode[] = [];
  if (results.some((r) => r.check === "DUPLICATE" && r.status === "FAILED")) {
    if (FLAG_RANK[cfg.duplicateFailedMinFlag] > FLAG_RANK[flag]) flag = cfg.duplicateFailedMinFlag;
    engineReasons.push("SYS_CHECK_FAILED_DUPLICATE");
  }

  const contribution = (r: CheckResult): number => (scored(r) ? (cfg.weights[r.check] ?? 0) * (r.risk as number) : 0);
  const byContribution = [...results].sort(
    (a, b) => contribution(b) - contribution(a) || CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check),
  );
  const reasons = [...new Set<ReasonCode>([...byContribution.flatMap((r) => r.reasons), ...engineReasons])];

  return { riskScore: Math.round(score * 10000) / 10000, flag, reasons, engineVersion };
}
