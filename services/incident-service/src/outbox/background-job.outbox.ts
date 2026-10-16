/**
 * Writes a background job in the caller's transaction (specs/006 P10, FR-043).
 *
 * `@da2/queue` workers skip messages without a `background_jobs` row (markProcessing), so the job
 * row and the outbox event share one id: the relay sends it as the envelope's jobId and the worker
 * finds its row. Nothing is lost when SQS or the process fails between commit and enqueue.
 */
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { GlobalStatus } from "../constants/status.enum";
import { ReportJobType } from "../constants/job-type.enum";
import { emitOutbox } from "./outbox.writer";

export async function emitBackgroundJob(
  tx: Prisma.TransactionClient,
  job: {
    jobType: ReportJobType.ANALYZE_REPORT | ReportJobType.TRANSLATE_TEXT;
    payload: Prisma.InputJsonValue;
    aggregateId: string;
    dedupKey: string;
  },
): Promise<void> {
  const id = randomUUID();
  await tx.backgroundJob.create({
    data: { id, jobType: job.jobType, payload: job.payload, status: GlobalStatus._STATUS_PENDING, attempts: 0 },
  });
  await emitOutbox(tx, {
    id,
    aggregateType: "report",
    aggregateId: job.aggregateId,
    eventType: job.jobType,
    payload: job.payload,
    dedupKey: job.dedupKey,
  });
}
