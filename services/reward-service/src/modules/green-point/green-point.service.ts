import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";
import type { GreenPointFactory } from "./green-point.factory";
import { getGreenPointSqsRepository } from "./green-point-sqs.repository";
import {
  CAMPAIGN_COMPLETION_JOB_TYPE,
  MAX_CAMPAIGN_COMPLETION_CREDITS_PER_ENQUEUE,
  type CampaignCompletionGreenPointsPayload,
} from "./green-point.types";

export class GreenPointService {
  constructor(private readonly greenPointFactory: GreenPointFactory) {}

  /**
   * Deserialize a queued job and apply using the factory-resolved strategy inside one
   * Serializable transaction.
   */
  async applyQueuedJob(envelope: {
    jobType: string;
    payload: unknown;
  }): Promise<{ credited: number; skipped: number }> {
    const strategy = this.greenPointFactory.getStrategy(envelope.jobType);
    const payload = strategy.validatePayload(envelope.payload);

    return prisma.$transaction(
      async (tx) => strategy.applyInTransaction(tx, payload),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  }

  async enqueue(jobType: string, payload: unknown): Promise<void> {
    const strategy = this.greenPointFactory.getStrategy(jobType);
    strategy.validatePayload(payload);

    const repo = getGreenPointSqsRepository();
    const body = JSON.stringify({
      version: 1,
      jobType,
      createdAt: new Date().toISOString(),
      payload,
    });
    await repo.sendMessage(body);
  }

  async enqueueCampaignCompletionCredits(
    payload: CampaignCompletionGreenPointsPayload,
  ): Promise<void> {
    if (payload.credits.length > MAX_CAMPAIGN_COMPLETION_CREDITS_PER_ENQUEUE) {
      throw new Error(
        `At most ${MAX_CAMPAIGN_COMPLETION_CREDITS_PER_ENQUEUE} credits per enqueue request`,
      );
    }
    await this.enqueue(CAMPAIGN_COMPLETION_JOB_TYPE, payload);
  }
}
