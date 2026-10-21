import prisma from "../../config/prisma.client";

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

    // Bonus caps were removed with the point-rules refactor (spec 013); this endpoint goes in wave C.
    const bonusCap = 0;

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
