import { isCompletionFlagged } from "@da2/constants";
import { VoteValue } from "../../../constants/status.enum";
import { GlobalStatus } from "../../../constants/status.enum";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";
import { campaignRepository } from "../campaign.repository";
import {
  CampaignCompletionVerificationActionResponse,
  CampaignCompletionVerificationSummary,
} from "./campaign_completion_verification.dto";
import { campaignCompletionVerificationRepository } from "./campaign_completion_verification.repository";

export class CampaignCompletionVerificationService {
  async getSummariesForCampaigns(
    campaignIds: string[],
    viewerUserId?: string | null,
  ): Promise<Map<string, CampaignCompletionVerificationSummary>> {
    const uniqueIds = [...new Set(campaignIds)];
    const result = new Map<string, CampaignCompletionVerificationSummary>();
    if (uniqueIds.length === 0) {
      return result;
    }

    const [countMap, myValues] = await Promise.all([
      campaignCompletionVerificationRepository.aggregateCountsByCampaign(
        uniqueIds,
      ),
      viewerUserId
        ? campaignCompletionVerificationRepository.findMyValuesForCampaigns(
            viewerUserId,
            uniqueIds,
          )
        : Promise.resolve(new Map<string, number>()),
    ]);

    for (const id of uniqueIds) {
      const counts = countMap.get(id) ?? { cleanCount: 0, notCleanCount: 0 };
      result.set(id, {
        cleanCount: counts.cleanCount,
        notCleanCount: counts.notCleanCount,
        flagged: isCompletionFlagged(counts.cleanCount, counts.notCleanCount),
        myVerification:
          viewerUserId != null
            ? (myValues.get(id) ?? VoteValue.NONE)
            : null,
      });
    }
    return result;
  }

  private async ensureVerifiableCampaign(campaignId: string): Promise<void> {
    const campaign = await campaignRepository.findById(campaignId);
    if (!campaign) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
      );
    }
    const allowed: number[] = [
      GlobalStatus._STATUS_WAITING_CONFIRMED,
      GlobalStatus._STATUS_COMPLETED,
    ];
    if (!allowed.includes(campaign.status)) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "Completion verification is only available after the campaign is submitted for completion",
        ),
      );
    }
  }

  private nextValue(current: number | null, requested: 1 | -1): number {
    if (current === requested) {
      return VoteValue.NONE;
    }
    return requested;
  }

  async submit(
    userId: string,
    campaignId: string,
    requested: 1 | -1,
  ): Promise<CampaignCompletionVerificationActionResponse> {
    await this.ensureVerifiableCampaign(campaignId);
    const existing = await campaignCompletionVerificationRepository.findActive(
      userId,
      campaignId,
    );
    const value = this.nextValue(existing?.value ?? null, requested);
    await campaignCompletionVerificationRepository.upsert(
      userId,
      campaignId,
      value,
    );
    return { campaignId, value };
  }
}

export const campaignCompletionVerificationService =
  new CampaignCompletionVerificationService();
