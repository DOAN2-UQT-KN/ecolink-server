// --- Admin: point rules ---

export interface PatchGamificationPointRulesBody {
  campaignCompletionPoints: number;
  baseReportPoint: number;
  reportMilestoneThresholds: number[];
  reportCompletionPoints: number;
  pointExpirationDays: number;
}

export interface GamificationPointRulesDto extends PatchGamificationPointRulesBody {
  id: string;
  effectiveFrom: string;
  updatedAt: string;
}

export interface GamificationPointRulesOneEnvelopeData {
  rules: GamificationPointRulesDto;
}

export interface GamificationPointRuleHistoryItemDto {
  id: string;
  changedBy: string;
  changedByName: string | null;
  changedAt: string;
  before: PatchGamificationPointRulesBody | null;
  after: PatchGamificationPointRulesBody;
}

export interface GamificationPointRuleHistoryEnvelopeData {
  items: GamificationPointRuleHistoryItemDto[];
  meta: { page: number; limit: number; total: number };
}
