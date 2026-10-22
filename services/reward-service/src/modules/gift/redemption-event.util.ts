import {
  GiftRedemptionActorRole,
  GiftRedemptionEvent,
  GiftRedemptionEventType,
  GiftRedemptionStatus,
  Prisma,
} from "@prisma/client";
import type { GiftRedemptionEventResponse } from "./gift.dto";

type Tx = Prisma.TransactionClient;

/**
 * Order history is append-only (spec 017 FR-032): this is the only writer, and it only inserts.
 * Call it inside the transaction that changes the order, so both commit or neither does.
 */
export async function recordEvent(
  tx: Tx,
  event: {
    redemptionId: string;
    type: GiftRedemptionEventType;
    fromStatus?: GiftRedemptionStatus | null;
    toStatus?: GiftRedemptionStatus | null;
    actorRole: GiftRedemptionActorRole;
    actorId: string | null;
    data?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.giftRedemptionEvent.create({
    data: {
      redemptionId: event.redemptionId,
      type: event.type,
      fromStatus: event.fromStatus ?? null,
      toStatus: event.toStatus ?? null,
      actorRole: event.actorRole,
      actorId: event.actorId,
      data: event.data ? (event.data as Prisma.InputJsonValue) : Prisma.DbNull,
    },
  });
}

/** The customer's view leaves out who the admin was (FR-041). */
export function toEventResponse(
  row: GiftRedemptionEvent,
  options: { withActor: boolean; actorNames?: Map<string, string | null> },
): GiftRedemptionEventResponse {
  const base: GiftRedemptionEventResponse = {
    id: row.id,
    type: row.type,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    actorRole: row.actorRole,
    data: (row.data as Record<string, unknown> | null) ?? null,
    reconstructed: row.reconstructed,
    createdAt: row.createdAt.toISOString(),
  };
  if (!options.withActor) return base;
  return {
    ...base,
    actor: row.actorId
      ? { id: row.actorId, name: options.actorNames?.get(row.actorId) ?? null }
      : null,
  };
}
