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

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeDifficulty(row: unknown): RewardDifficulty | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  const id = typeof r.id === "string" ? r.id : null;
  const name = typeof r.name === "string" ? r.name : "";
  const level = toNumberOrNull(r.level);
  const greenPoints = toNumberOrNull(r.greenPoints);
  const maxVolunteersRaw = toNumberOrNull(r.maxVolunteers);
  const maxVolunteers = maxVolunteersRaw === null ? null : maxVolunteersRaw;

  if (!id || level === null || greenPoints === null) return null;

  return {
    id,
    name,
    level,
    greenPoints,
    maxVolunteers,
  };
}

function normalizeDifficulties(rows: unknown[]): RewardDifficulty[] {
  return rows
    .map((r) => normalizeDifficulty(r))
    .filter((r): r is RewardDifficulty => r !== null);
}

function readDifficultiesFromResponse(data: unknown): RewardDifficulty[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const root = data as Record<string, unknown>;
  if (root.success === false) {
    return [];
  }
  const inner = root.data;
  if (inner && typeof inner === "object") {
    const innerDifficulties = (inner as { difficulties?: unknown }).difficulties;
    if (Array.isArray(innerDifficulties)) {
      return normalizeDifficulties(innerDifficulties);
    }
  }
  const topDifficulties = root.difficulties;
  if (Array.isArray(topDifficulties)) {
    return normalizeDifficulties(topDifficulties);
  }
  return [];
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

  private logCallFailure(
    action: string,
    err: unknown,
    extra?: Record<string, unknown>,
  ): void {
    if (process.env.NODE_ENV === "production") return;
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const statusText = err.response?.statusText;
      const message =
        (err.response?.data as { message?: string } | undefined)?.message ??
        err.message;
      console.warn(`[reward-service] ${action} failed`, {
        status,
        statusText,
        message,
        baseURL: process.env.REWARD_SERVICE_URL,
        ...extra,
      });
      return;
    }
    console.warn(`[reward-service] ${action} failed`, {
      message: err instanceof Error ? err.message : String(err),
      baseURL: process.env.REWARD_SERVICE_URL,
      ...extra,
    });
  }

  async getDifficulties(): Promise<RewardDifficulty[]> {
    try {
      const client = this.getClient();
      const { data } = await client.get<
        SuccessEnvelope<{ difficulties: RewardDifficulty[] }>
      >("/internal/v1/difficulties");
      return readDifficultiesFromResponse(data);
    } catch (e) {
      this.logCallFailure("getDifficulties", e);
      return [];
    }
  }

  async getDifficultyByLevel(
    level: number,
  ): Promise<RewardDifficulty | null> {
    try {
      const client = this.getClient();
      const { data } = await client.get<
        SuccessEnvelope<{ difficulty: RewardDifficulty }>
      >(`/internal/v1/difficulties/level/${level}`);
      if (!data?.success || !data.data?.difficulty) {
        return null;
      }
      return normalizeDifficulty(data.data.difficulty);
    } catch (e) {
      this.logCallFailure("getDifficultyByLevel", e, { level });
      return null;
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
