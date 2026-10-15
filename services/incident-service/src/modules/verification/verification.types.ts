import type { ReasonCode } from "../../constants/report-verification";

export type CheckName = "DUPLICATE" | "TRUST" | "CONTEXT";

export type CheckStatus = "COMPLETED" | "SKIPPED" | "FAILED" | "NOT_AVAILABLE";

export interface Signal {
  name: string;
  status: CheckStatus;
  /** 0..1, higher = riskier; null unless COMPLETED. Never 0 for "no data". */
  risk: number | null;
  raw?: number | null;
}

/** The single shape every check returns; the risk engine reads only this. */
export interface CheckResult {
  check: CheckName;
  version: string;
  status: CheckStatus;
  risk: number | null;
  reasons: ReasonCode[];
  /** Always the full signal list of the check, including skipped/not-available ones. */
  signals: Signal[];
  evidence: Record<string, unknown>;
  error?: { code: string; message: string };
  durationMs: number;
}

export type RiskFlag = "ACCEPT" | "REVIEW" | "REJECT";

export interface Assessment {
  riskScore: number;
  flag: RiskFlag;
  reasons: ReasonCode[];
  engineVersion: string;
}
