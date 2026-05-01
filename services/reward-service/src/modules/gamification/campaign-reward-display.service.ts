import prisma from "../../config/prisma.client";
import { gamificationConfigService } from "./gamification-config.service";

/**
 * Public UX: base from difficulty + estimated bonus cap (no multipliers).
 */
export class CampaignRewardDisplayService {
  async getEstimateForDifficultyLevel(level: number): Promise<{
    difficultyLevel: number;
    basePoints: number;
    estimatedBonusMax: number;
    estimatedRange: { min: number; max: number };
    difficultyName: string | null;
  } | null> {
    const difficulty = await prisma.difficulty.findFirst({
      where: { level, deletedAt: null },
    });
    if (!difficulty) {
      return null;
    }

    const rules = await gamificationConfigService.getActivePointRules();
    let bonusCap = 0;
    const caps = rules?.volunteerBonusCapByDifficulty;
    if (caps && typeof caps === "object" && !Array.isArray(caps)) {
      const raw = (caps as Record<string, unknown>)[String(level)];
      if (typeof raw === "number") {
        bonusCap = raw;
      }
    }

    const basePoints = difficulty.greenPoints;
    return {
      difficultyLevel: level,
      basePoints,
      estimatedBonusMax: bonusCap,
      estimatedRange: {
        min: basePoints,
        max: basePoints + bonusCap,
      },
      difficultyName: difficulty.name,
    };
  }
}

export const campaignRewardDisplayService = new CampaignRewardDisplayService();
