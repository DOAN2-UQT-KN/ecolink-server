import type { ReasonCode } from "../../../constants/report-verification";
import type { ChecksConfig } from "../verification-config.types";
import type { CheckResult, CheckStatus, Signal } from "../verification.types";

type TrustConfig = ChecksConfig["trust"];

export interface TrustInput {
  /** Null when the report has no image. */
  images: { live: number; gallery: number } | null;
  /** Null when the report has no user. */
  history: { total: number; rejected: number } | null;
  /** Null when the report has no user; "FAILED" when identity did not answer. */
  accountAgeDays: number | null | "FAILED";
}

type SignalName = keyof TrustConfig["weights"];

const signal = (name: SignalName, status: CheckStatus, risk: number | null = null, raw: number | null = null): Signal => ({
  name,
  status,
  risk,
  raw,
});

/**
 * TrustCheck score from server-side facts only (specs/006 FR-024). Pure: the check gathers the
 * inputs. Risk = weighted mean over the signals that completed.
 */
export function scoreTrust(input: TrustInput, cfg: TrustConfig): Omit<CheckResult, "check" | "version" | "durationMs"> {
  const signals: Signal[] = [];
  const reasons: ReasonCode[] = [];

  const images = input.images;
  if (!images || images.live + images.gallery === 0) {
    signals.push(signal("capture", "SKIPPED"));
  } else {
    signals.push(signal("capture", "COMPLETED", images.gallery > 0 ? cfg.galleryRisk : 0, images.gallery));
    if (images.gallery > 0) reasons.push("TRUST_NOT_LIVE_CAPTURE");
  }

  const history = input.history;
  if (!history) {
    signals.push(signal("reject_history", "SKIPPED"));
  } else {
    // Additive smoothing: a user with little history is pulled toward the prior instead of 0% / 100%.
    const risk = (history.rejected + cfg.smoothing.addRejected) / (history.total + cfg.smoothing.addTotal);
    signals.push(signal("reject_history", "COMPLETED", risk, history.rejected));
    if (history.total >= cfg.highRejectMinTotal && history.rejected / history.total > cfg.highRejectRate) {
      reasons.push("TRUST_HIGH_REJECT_RATE");
    }
  }

  const days = input.accountAgeDays;
  if (days === null) {
    signals.push(signal("account_age", "SKIPPED"));
  } else if (days === "FAILED") {
    signals.push(signal("account_age", "FAILED"));
  } else {
    const step = cfg.accountAgeSteps.find((s) => days < s.belowDays);
    signals.push(signal("account_age", "COMPLETED", step ? step.risk : 0, days));
    if (days < cfg.newAccountDays) reasons.push("TRUST_NEW_ACCOUNT");
  }

  const completed = signals.filter((s) => s.status === "COMPLETED");
  const totalWeight = completed.reduce((sum, s) => sum + cfg.weights[s.name as SignalName], 0);
  const status: CheckStatus =
    completed.length > 0 ? "COMPLETED" : signals.some((s) => s.status === "FAILED") ? "FAILED" : "SKIPPED";
  const risk =
    status === "COMPLETED" && totalWeight > 0
      ? Math.round(
          (completed.reduce((sum, s) => sum + cfg.weights[s.name as SignalName] * (s.risk as number), 0) / totalWeight) *
            10_000,
        ) / 10_000
      : null;

  return {
    status,
    risk,
    reasons,
    signals,
    evidence: {
      images,
      totalReports90d: history?.total ?? null,
      rejected90d: history?.rejected ?? null,
      accountAgeDays: typeof days === "number" ? days : null,
    },
  };
}
