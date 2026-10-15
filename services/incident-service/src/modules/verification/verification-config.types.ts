import type { ReportCategory } from "@prisma/client";
import type { CheckName, RiskFlag } from "./verification.types";

export type VerificationConfigKey = "pipeline" | "engine" | "checks" | "category-rules";

export interface PipelineConfig {
  maxAttempts: number;
  checkTimeoutMs: number;
}

export interface EngineConfig {
  weights: Record<CheckName, number>;
  thresholds: { review: number; reject: number };
  duplicateFailedMinFlag: RiskFlag;
}

export interface ChecksConfig {
  duplicate: {
    version: string;
    phashGlobalMax: number;
    phashCandidateMax: number;
    candidateRadiusM: number;
    candidateDays: number;
    orbMinInliers: number;
    orbMinInlierRatio: number;
    nearbyRadiusM: number;
    nearbyHours: number;
    risk: { phashStrict: number; phashLoose: number; orb: number; internet: number };
  };
  trust: {
    version: string;
    weights: { capture: number; reject_history: number; account_age: number };
    galleryRisk: number;
    rejectWindowDays: number;
    smoothing: { addRejected: number; addTotal: number };
    highRejectMinTotal: number;
    highRejectRate: number;
    accountAgeSteps: { belowDays: number; risk: number }[];
    newAccountDays: number;
  };
  context: {
    version: string;
    goongTimeoutMs: number;
    cacheTtlDays: number;
    suggestTimeoutMs: number;
  };
}

export type FitRule =
  | { kind: "NONE" }
  | {
      kind: "NEARBY_PLACE";
      keywords: string[];
      maxDistanceM: number;
      missRisk: number;
      /** WATERWAY only: address words that also count as evidence. */
      addressHints?: string[];
    }
  | { kind: "ADDRESS_PATTERN"; patterns: string[]; missRisk: number }
  | { kind: "ON_STREET"; maxDistanceM: number; missRisk: number };

export type CategoryRulesConfig = Record<ReportCategory, FitRule>;

export interface ConfigValueByKey {
  pipeline: PipelineConfig;
  engine: EngineConfig;
  checks: ChecksConfig;
  "category-rules": CategoryRulesConfig;
}
