import axios, { AxiosInstance } from "axios";
import {
  getHttpCircuit,
  HTTP_CIRCUIT_REWARD,
  type HttpCircuit,
} from "../../resilience/http-circuit";
import { HttpError, HTTP_STATUS } from "../../constants/http-status";

export interface RewardDifficulty {
  id: string;
  level: number;
  name: string;
  maxVolunteers: number | null;
  /** Suggested minimum volunteers per campaign day; null = no suggestion. */
  suggestedMinVolunteers: number | null;
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
  const suggestedMinVolunteers = toNumberOrNull(r.suggestedMinVolunteers);

  if (!id || level === null || greenPoints === null) return null;

  return {
    id,
    name,
    level,
    greenPoints,
    maxVolunteers,
    suggestedMinVolunteers,
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
  private readonly circuit: HttpCircuit;

  constructor(circuit?: HttpCircuit) {
    this.circuit = circuit ?? getHttpCircuit(HTTP_CIRCUIT_REWARD);
  }

  getCircuitState(): string {
    return this.circuit.getState();
  }

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
      return await this.circuit.run(async () => {
        const client = this.getClient();
        const { data } = await client.get<
          SuccessEnvelope<{ difficulties: RewardDifficulty[] }>
        >("/internal/v1/difficulties");
        return readDifficultiesFromResponse(data);
      });
    } catch (e) {
      this.logCallFailure("getDifficulties", e);
      return [];
    }
  }

  /**
   * The tier for a level: `null` only when reward-service answers 404 (no such level). Not being
   * able to reach it (network, timeout, 5xx, open circuit, missing env) throws 503
   * `REWARD_SERVICE_UNAVAILABLE`, so callers never mistake an outage for an invalid difficulty.
   * A 404 is an answer, not a failure: it does not count against the circuit breaker.
   */
  async getDifficultyByLevelStrict(
    level: number,
  ): Promise<RewardDifficulty | null> {
    try {
      return await this.circuit.run(async () => {
        const client = this.getClient();
        try {
          const { data } = await client.get<
            SuccessEnvelope<{ difficulty: RewardDifficulty }>
          >(`/internal/v1/difficulties/level/${level}`);
          if (!data?.success || !data.data?.difficulty) {
            return null;
          }
          return normalizeDifficulty(data.data.difficulty);
        } catch (err) {
          if (axios.isAxiosError(err) && err.response?.status === 404) {
            return null;
          }
          throw err;
        }
      });
    } catch (e) {
      this.logCallFailure("getDifficultyByLevel", e, { level });
      throw new HttpError(HTTP_STATUS.REWARD_SERVICE_UNAVAILABLE);
    }
  }

  /** Same lookup for display (points, suggested minimum): `null` on any failure, never throws. */
  async getDifficultyByLevel(
    level: number,
  ): Promise<RewardDifficulty | null> {
    try {
      return await this.getDifficultyByLevelStrict(level);
    } catch {
      return null;
    }
  }
}

export const rewardServiceClient = new RewardServiceClient();
