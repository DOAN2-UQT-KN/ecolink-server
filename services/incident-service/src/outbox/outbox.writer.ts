import { Prisma } from "@prisma/client";
import { GlobalStatus } from "../constants/status.enum";
import type { OutboxEventType } from "./outbox.types";

export interface OutboxEventInput {
  aggregateType: "report" | "campaign" | "vote" | "organization_application";
  aggregateId: string;
  eventType: OutboxEventType;
  payload: Prisma.InputJsonValue;
  /** Deterministic dedup key, e.g. `REPORT_COMPLETION_GREEN_POINTS:<reportId>`. */
  dedupKey: string;
}

/**
 * Persist an outbox event. MUST be called with the same `tx` as the business
 * write so the event and the state change commit (or roll back) atomically.
 *
 * `skipDuplicates` + the unique `dedupKey` make re-emits / reconciliation safe.
 */
export async function emitOutbox(
  tx: Prisma.TransactionClient,
  event: OutboxEventInput,
): Promise<void> {
  await tx.outboxEvent.createMany({
    data: [
      {
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
        dedupKey: event.dedupKey,
        status: GlobalStatus._STATUS_PENDING,
      },
    ],
    skipDuplicates: true,
  });
}
