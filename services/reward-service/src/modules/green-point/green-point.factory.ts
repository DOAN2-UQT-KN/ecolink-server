import type { GreenPointCreditStrategy } from "./strategies/green-point-credit-strategy.types";
import { CampaignCompletionGreenPointStrategy } from "./strategies/campaign-completion-green-point.strategy";
import { ReferralAddingGreenPointServiceStrategy } from "./strategies/referral-adding-green-point-service.strategy";
import { UpvoteAddingGreenPointStrategy } from "./strategies/upvote-adding-green-point.strategy";

/**
 * Resolves the {@link GreenPointCreditStrategy} for an SQS envelope `jobType`.
 */
export class GreenPointFactory {
  private readonly byJobType = new Map<string, GreenPointCreditStrategy>();

  constructor(strategies: GreenPointCreditStrategy[]) {
    for (const strategy of strategies) {
      if (this.byJobType.has(strategy.queueJobType)) {
        throw new Error(
          `Duplicate green point strategy for job type: ${strategy.queueJobType}`,
        );
      }
      this.byJobType.set(strategy.queueJobType, strategy);
    }
  }

  getStrategy(jobType: string): GreenPointCreditStrategy {
    const strategy = this.byJobType.get(jobType);
    if (!strategy) {
      throw new Error(`Unknown green point job type: ${jobType}`);
    }
    return strategy;
  }

  supportsJobType(jobType: string): boolean {
    return this.byJobType.has(jobType);
  }

  static createDefault(): GreenPointFactory {
    return new GreenPointFactory([
      new CampaignCompletionGreenPointStrategy(),
      new UpvoteAddingGreenPointStrategy(),
      new ReferralAddingGreenPointServiceStrategy(),
    ]);
  }
}
