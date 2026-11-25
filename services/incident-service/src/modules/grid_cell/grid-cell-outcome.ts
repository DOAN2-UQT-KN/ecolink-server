import { SHIFT_RESULT_REPORT_STATUS } from "@da2/constants";

export type CellOutcome = "cleaned" | "partial";

/**
 * Result of cleaning ONE cell on ONE shift, from the status ("cleaned" | "partial") the shift's
 * result gave to each report of that cell. Cells are 100 m wide, so a cell often holds several
 * reports and they may disagree. The outcome is what the recurrence model learns from.
 */
export function resolveCellOutcome(statuses: readonly string[]): CellOutcome {
  // TODO(human): decide when a cell counts as "cleaned" and when only "partial".
  return statuses.every((s) => s === SHIFT_RESULT_REPORT_STATUS.CLEANED) ? "cleaned" : "partial";
}
