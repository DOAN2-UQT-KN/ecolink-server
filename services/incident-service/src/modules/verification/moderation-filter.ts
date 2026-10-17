import type { Prisma } from "@prisma/client";
import { REPORT_STATUS_IN_REVIEW, REPORT_STATUS_REJECTED } from "../../constants/report-verification";

export type ModerationTab = "REVIEW" | "REJECT";

/** Reports a moderator still has to look at; shared by the queue and admin report search (specs/008). */
export const MODERATION_TAB_FILTER: Record<ModerationTab, Prisma.ReportWhereInput> = {
  REVIEW: { deletedAt: null, status: REPORT_STATUS_IN_REVIEW },
  // Auto-rejected by the engine: rejected, never touched by a moderator, has a verification.
  REJECT: {
    deletedAt: null,
    status: REPORT_STATUS_REJECTED,
    moderatedBy: null,
    latestVerificationId: { not: null },
  },
};

/** Highest risk first (unscored last), then oldest first. */
export const MODERATION_ORDER_BY: Prisma.ReportOrderByWithRelationInput[] = [
  { latestVerification: { riskScore: { sort: "desc", nulls: "last" } } },
  { createdAt: "asc" },
];
