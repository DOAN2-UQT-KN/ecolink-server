import { SHIFT_STATUS, type ShiftStatusValue } from "@da2/constants";

/** When the shift actually ends: earlier than planned when its leader ended it early (spec 4.2). */
export function effectiveEnd(shift: { endAt: Date; endedAt?: Date | null }): Date {
  return shift.endedAt ?? shift.endAt;
}

/**
 * Spec 4.2: a shift's status, derived from data (never stored, so no job lag):
 * off (minVolunteers 0) → upcoming → running → awaiting_result (past its end, no result) → ended.
 */
export function shiftStatusOf(
  shift: { startAt: Date; endAt: Date; endedAt?: Date | null; minVolunteers: number },
  hasResult: boolean,
  now = new Date(),
): ShiftStatusValue {
  if (shift.minVolunteers <= 0) return SHIFT_STATUS.OFF;
  const t = now.getTime();
  if (t < shift.startAt.getTime()) return SHIFT_STATUS.UPCOMING;
  if (t < effectiveEnd(shift).getTime()) return SHIFT_STATUS.RUNNING;
  return hasResult ? SHIFT_STATUS.ENDED : SHIFT_STATUS.AWAITING_RESULT;
}
