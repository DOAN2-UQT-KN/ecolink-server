import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";
import type { GreenPointFactory } from "./green-point.factory";
import { backgroundJobDispatcher } from "../../queue/green-point-queue.bootstrap";
import {
  CAMPAIGN_COMPLETION_JOB_TYPE,
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
    await backgroundJobDispatcher.enqueue(jobType, payload);
  }

  async enqueueCampaignCompletionCredits(
    payload: CampaignCompletionGreenPointsPayload,
  ): Promise<void> {
    await this.enqueue(CAMPAIGN_COMPLETION_JOB_TYPE, payload);
  }
}
