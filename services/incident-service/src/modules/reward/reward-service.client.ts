import axios, { AxiosInstance } from "axios";

export interface RewardDifficulty {
  id: string;
  level: number;
  name: string;
  maxVolunteers: number | null;
  greenPoints: number;
}

interface SuccessEnvelope<T> {
  success: boolean;
  data?: T;
}

export class RewardServiceClient {
  private getClient(): AxiosInstance {
    const baseURL = process.env.REWARD_SERVICE_URL;
    const key = process.env.INTERNAL_REWARD_API_KEY;
    if (!baseURL?.trim() || !key?.trim()) {
      throw new Error(
        "REWARD_SERVICE_URL and INTERNAL_REWARD_API_KEY must be configured",
      );
    }
    return axios.create({
      baseURL: baseURL.replace(/\/$/, ""),
      timeout: 10_000,
      headers: { "x-internal-api-key": key },
    });
  }

  async getDifficulties(): Promise<RewardDifficulty[]> {
    const client = this.getClient();
    const { data } = await client.get<
      SuccessEnvelope<{ difficulties: RewardDifficulty[] }>
    >("/internal/v1/difficulties");
    if (!data?.success || !data.data?.difficulties) {
      throw new Error("Invalid reward service list response");
    }
    return data.data.difficulties;
  }

  async getDifficultyByLevel(
    level: number,
  ): Promise<RewardDifficulty | null> {
    const client = this.getClient();
    try {
      const { data } = await client.get<
        SuccessEnvelope<{ difficulty: RewardDifficulty }>
      >(`/internal/v1/difficulties/level/${level}`);
      if (!data?.success || !data.data?.difficulty) {
        return null;
      }
      return data.data.difficulty;
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.status === 404) {
        return null;
      }
      throw e;
    }
  }

  /** Same as SQS / factory `jobType` for campaign completion batches. */
  private static readonly GREEN_POINT_JOB_CAMPAIGN_COMPLETION =
    "CAMPAIGN_COMPLETION_GREEN_POINTS" as const;

  /**
   * Queue green-point credits for approved campaign volunteers (reward worker applies
   * with Serializable transactions).
   */
  async enqueueCampaignCompletionGreenPoints(body: {
    campaignId: string;
    credits: { userId: string; points: number }[];
  }): Promise<void> {
    const client = this.getClient();
    try {
      const { data } = await client.post<
        SuccessEnvelope<{
          queued: boolean;
          type: string;
        }>
      >("/internal/v1/green-points/enqueue", {
        type: RewardServiceClient.GREEN_POINT_JOB_CAMPAIGN_COMPLETION,
        payload: body,
      });
      if (!data?.success || !data.data?.queued) {
        throw new Error("Invalid reward service enqueue green points response");
      }
    } catch (e) {
      if (axios.isAxiosError(e)) {
        const apiMsg =
          (e.response?.data as { message?: string } | undefined)?.message ??
          e.message;
        throw new Error(`Reward service enqueue failed: ${apiMsg}`);
      }
      throw e;
    }
  }

  async assertCampaignHasCapacityForJoinApproval(
    currentApprovedCount: number,
    difficultyLevel: number,
  ): Promise<void> {
    const d = await this.getDifficultyByLevel(difficultyLevel);
    if (!d) {
      throw new Error("Campaign difficulty missing");
    }
    if (d.maxVolunteers === null) {
      return;
    }
    if (currentApprovedCount >= d.maxVolunteers) {
      throw new Error(
        `Campaign volunteer capacity exceeded for this difficulty (max ${d.maxVolunteers})`,
      );
    }
  }
}

export const rewardServiceClient = new RewardServiceClient();
