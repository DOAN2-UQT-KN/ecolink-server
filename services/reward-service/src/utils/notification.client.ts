interface SuccessEnvelope<T> {
  success: boolean;
  data?: T;
}

/**
 * In-app notification to the order's owner once it ships (spec 017 FR-050). Best effort: the caller
 * logs a failure, the shipment itself is already committed.
 */
export async function enqueueGiftOrderShippedNotification(params: {
  userId: string;
  orderCode: string;
  giftNameEn: string;
  giftNameVi: string;
  carrier: string;
  trackingCode: string;
  /** Items in the order (spec 018); templates show "× N". */
  quantity: number;
}): Promise<void> {
  const baseURL = process.env.NOTIFICATION_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_NOTIFICATION_API_KEY?.trim();
  if (!baseURL || !key) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[reward-service] NOTIFICATION_SERVICE_URL or INTERNAL_NOTIFICATION_API_KEY not set; skipping gift shipped notification",
      );
    }
    return;
  }

  const { userId, ...payload } = params;
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/api/v1/notifications/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-api-key": key },
    body: JSON.stringify({ type: "website", kind: "GIFT_ORDER_SHIPPED", userId, payload }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => null)) as SuccessEnvelope<{ accepted: boolean }> | null;
  if (!res.ok || !data?.success) {
    throw new Error("Notification service rejected GIFT_ORDER_SHIPPED job");
  }
}
