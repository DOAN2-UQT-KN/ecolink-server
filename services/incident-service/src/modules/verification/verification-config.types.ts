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
    /** Signal `internet` (specs/011); absent in checks@1.0.0, which means disabled. */
    web?: {
      enabled: boolean;
      dailyLimit: number;
      maxImages: number;
      batchSize: number;
      maxCandidates: number;
      maxResults: number;
      callTimeoutMs: number;
      totalTimeoutMs: number;
      fetchTimeoutMs: number;
      fetchMaxBytes: number;
      cacheTtlDays: number;
      blockedHosts: string[];
    };
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
    /** Postgres statement_timeout for each OSM query (specs/012). */
    queryTimeoutMs: number;
    suggestTimeoutMs: number;
  };
}

/** OSM feature classes assigned at import time (scripts/osm/osm-context.lua, specs/012). */
export type FeatureClass = "waterway" | "beach" | "market" | "school" | "park" | "industrial" | "alley" | "street";

export type FitRule =
  | { kind: "NONE" }
  | {
      kind: "NEAR_FEATURE";
      classes: FeatureClass[];
      maxDistanceM: number;
      missRisk: number;
      /** Only conclude MISMATCH where the map is drawn densely enough (coverage). */
      requireCoverage?: boolean;
    };

export interface CategoryRulesConfig {
  rules: Record<ReportCategory, FitRule>;
  /** Fewer than `minPoi` amenity/shop points within `radiusM` = not enough data to conclude. */
  coverage: { radiusM: number; minPoi: number };
}

export interface ConfigValueByKey {
  pipeline: PipelineConfig;
  engine: EngineConfig;
  checks: ChecksConfig;
  "category-rules": CategoryRulesConfig;
}
