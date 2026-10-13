import { SHIFT_STATUS, type ShiftStatusValue } from "@da2/constants";

/** When the shift actually ends: earlier than planned when its leader ended it early (spec 4.2). */
export function effectiveEnd(shift: { endAt: Date; endedAt?: Date | null }): Date {
  return shift.endedAt ?? shift.endAt;
}

/** A result counts unless the admin reopened the shift when rejecting the completion (spec 5.2). */
export function hasLiveResult(
  result: { reopenedAt?: Date | null } | null | undefined,
): boolean {
  return result != null && result.reopenedAt == null;
}

/**
 * Spec 4.2: a shift's status, derived from data (never stored, so no job lag):
 * off (minVolunteers 0) → upcoming → running → awaiting_result (past its end, no result, or its
 * result reopened by the admin) → ended.
 */
export function shiftStatusOf(
  shift: { startAt: Date; endAt: Date; endedAt?: Date | null; minVolunteers: number },
  /** Whether it has a result, or the result itself (a reopened result does not count). */
  result: boolean | { reopenedAt?: Date | null } | null | undefined,
  now = new Date(),
): ShiftStatusValue {
  const hasResult = typeof result === "boolean" ? result : hasLiveResult(result);
  if (shift.minVolunteers <= 0) return SHIFT_STATUS.OFF;
  const t = now.getTime();
  if (t < shift.startAt.getTime()) return SHIFT_STATUS.UPCOMING;
  if (t < effectiveEnd(shift).getTime()) return SHIFT_STATUS.RUNNING;
  return hasResult ? SHIFT_STATUS.ENDED : SHIFT_STATUS.AWAITING_RESULT;
}
