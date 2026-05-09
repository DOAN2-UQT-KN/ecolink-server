import { HttpError, HTTP_STATUS } from "../../constants/http-status";
import {
  VoteResourceType,
  VoteValue,
} from "../../constants/status.enum";
import { campaignRepository } from "../campaign/campaign.repository";
import { reportRepository } from "../report/report.repository";
import { rewardServiceClient } from "../reward/reward-service.client";
import {
  VoteActionBody,
  VoteActionResponse,
  ResourceVoteSummary,
} from "./vote.dto";
import { voteRepository } from "./vote.repository";

export class VoteService {
  /**
   * Vote totals per resource plus the viewer’s own vote (if viewerUserId is set).
   */
  async getVoteSummariesForResources(
    resourceType: VoteResourceType,
    resourceIds: string[],
    viewerUserId?: string | null,
  ): Promise<Map<string, ResourceVoteSummary>> {
    const uniqueIds = [...new Set(resourceIds)];
    const result = new Map<string, ResourceVoteSummary>();
    if (uniqueIds.length === 0) {
      return result;
    }

    const [countMap, myVotes] = await Promise.all([
      voteRepository.aggregateVoteCountsByResource(resourceType, uniqueIds),
      viewerUserId
        ? voteRepository.findMyVoteValuesForResources(
            viewerUserId,
            resourceType,
            uniqueIds,
          )
        : Promise.resolve(new Map<string, number>()),
    ]);

    for (const id of uniqueIds) {
      const counts = countMap.get(id) ?? { upvoteCount: 0, downvoteCount: 0 };
      result.set(id, {
        upvoteCount: counts.upvoteCount,
        downvoteCount: counts.downvoteCount,
        myVote:
          viewerUserId != null
            ? (myVotes.get(id) ?? VoteValue.NONE)
            : null,
      });
    }
    return result;
  }

  private async ensureVotableResource(
    resourceType: VoteResourceType,
    resourceId: string,
  ): Promise<void> {
    if (resourceType === VoteResourceType.REPORT) {
      const report = await reportRepository.findById(resourceId);
      if (!report) {
        throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
      }
      return;
    }
    if (resourceType === VoteResourceType.CAMPAIGN) {
      const campaign = await campaignRepository.findById(resourceId);
      if (!campaign) {
        throw new HttpError(
          HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
        );
      }
      return;
    }
    throw new HttpError(HTTP_STATUS.INVALID_INPUT);
  }

  private async enqueueReportVoteMilestoneIfNeeded(args: {
    resourceType: VoteResourceType;
    resourceId: string;
    newValue: number;
  }): Promise<void> {
    // Only enqueue for report upvotes (not downvotes, not toggling off).
    if (args.resourceType !== VoteResourceType.REPORT) return;
    if (args.newValue !== VoteValue.UP) return;

    try {
      const report = await reportRepository.findById(args.resourceId);
      const reportCreatorUserId = report?.userId ?? null;
      if (!reportCreatorUserId) return;

      const countsMap = await voteRepository.aggregateVoteCountsByResource(
        VoteResourceType.REPORT,
        [args.resourceId],
      );
      const counts = countsMap.get(args.resourceId) ?? {
        upvoteCount: 0,
        downvoteCount: 0,
      };

      await rewardServiceClient.enqueueReportVoteMilestoneGreenPoints({
        reportId: args.resourceId,
        reportCreatorUserId,
        voteCount: counts.upvoteCount,
      });
    } catch (e) {
      // Best-effort: do not block voting UX when reward enqueue fails.
      if (process.env.NODE_ENV !== "production") {
        console.warn("[incident-service] reward vote milestone enqueue failed", {
          resourceId: args.resourceId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  private nextUpvoteValue(current: number | null): number {
    if (current === VoteValue.UP) {
      return VoteValue.NONE;
    }
    return VoteValue.UP;
  }

  private nextDownvoteValue(current: number | null): number {
    if (current === VoteValue.DOWN) {
      return VoteValue.NONE;
    }
    return VoteValue.DOWN;
  }

  async upvote(
    userId: string,
    body: VoteActionBody,
  ): Promise<VoteActionResponse> {
    await this.ensureVotableResource(body.resourceType, body.resourceId);
    const existing = await voteRepository.findActive(
      userId,
      body.resourceType,
      body.resourceId,
    );
    const current = existing?.value ?? null;
    const value = this.nextUpvoteValue(current);
    await voteRepository.upsertVote(
      userId,
      body.resourceType,
      body.resourceId,
      value,
    );

    // Fire-and-forget enqueue of green point evaluation for report creators.
    void this.enqueueReportVoteMilestoneIfNeeded({
      resourceType: body.resourceType,
      resourceId: body.resourceId,
      newValue: value,
    });

    return {
      resourceId: body.resourceId,
      resourceType: body.resourceType,
      value,
    };
  }

  async downvote(
    userId: string,
    body: VoteActionBody,
  ): Promise<VoteActionResponse> {
    await this.ensureVotableResource(body.resourceType, body.resourceId);
    const existing = await voteRepository.findActive(
      userId,
      body.resourceType,
      body.resourceId,
    );
    const current = existing?.value ?? null;
    const value = this.nextDownvoteValue(current);
    await voteRepository.upsertVote(
      userId,
      body.resourceType,
      body.resourceId,
      value,
    );
    return {
      resourceId: body.resourceId,
      resourceType: body.resourceType,
      value,
    };
  }
}

export const voteService = new VoteService();
