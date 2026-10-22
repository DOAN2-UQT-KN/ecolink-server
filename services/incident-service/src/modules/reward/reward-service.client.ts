import axios, { AxiosInstance } from "axios";
import {
  getHttpCircuit,
  HTTP_CIRCUIT_REWARD,
  type HttpCircuit,
} from "../../resilience/http-circuit";

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

  /**
   * Campaign completion points from reward-service's active point rules (spec 013 FR-040): the
   * same for every campaign. `null` on any failure (display only, never blocks a request).
   */
  async getCampaignCompletionPoints(): Promise<number | null> {
    try {
      return await this.circuit.run(async () => {
        const client = this.getClient();
        try {
          const { data } = await client.get<
            SuccessEnvelope<{ campaignCompletionPoints: unknown }>
          >("/internal/v1/point-rules/campaign-completion");
          return data?.success ? toNumberOrNull(data.data?.campaignCompletionPoints) : null;
        } catch (err) {
          // No active rules is an answer, not an outage: keep it off the circuit breaker.
          if (axios.isAxiosError(err) && err.response?.status === 404) return null;
          throw err;
        }
      });
    } catch (e) {
      this.logCallFailure("getCampaignCompletionPoints", e);
      return null;
    }
  }
}

export const rewardServiceClient = new RewardServiceClient();
