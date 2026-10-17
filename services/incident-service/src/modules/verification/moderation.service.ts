import { Prisma, type ModerationReasonCode } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { HttpError, HTTP_STATUS } from "../../constants/http-status";
import {
  REPORT_STATUS_ACCEPTED,
  REPORT_STATUS_IN_REVIEW,
  REPORT_STATUS_REJECTED,
} from "../../constants/report-verification";
import { emitOutbox } from "../../outbox/outbox.writer";
import { OutboxEventType } from "../../outbox/outbox.types";
import { toReportResponse } from "../report/report.entity";

import { MODERATION_ORDER_BY, MODERATION_TAB_FILTER, type ModerationTab } from "./moderation-filter";

export type { ModerationTab };

export interface ModerationDecision {
  decision: "ACCEPT" | "REJECT";
  reasonCode?: ModerationReasonCode;
  note?: string;
}

/** Reports a moderator may still decide: in review, or rejected by the engine with nobody's decision yet. */
const AWAITING_MODERATION: Prisma.ReportWhereInput = {
  deletedAt: null,
  OR: [
    { status: REPORT_STATUS_IN_REVIEW },
    { status: REPORT_STATUS_REJECTED, moderatedBy: null, latestVerificationId: { not: null } },
  ],
};

export const moderationService = {
  /** Moderator queue, highest risk first (specs/006 FR-038). */
  async queue({ flag = "REVIEW", page = 1, limit = 20 }: { flag?: ModerationTab; page?: number; limit?: number }) {
    const where = MODERATION_TAB_FILTER[flag];
    const [rows, total, review, autoRejected] = await Promise.all([
      prisma.report.findMany({
        where,
        orderBy: MODERATION_ORDER_BY,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          latestVerification: { select: { riskScore: true, reasons: true } },
          reportMediaFiles: { where: { deletedAt: null }, take: 1, include: { media: { select: { url: true } } } },
        },
      }),
      prisma.report.count({ where }),
      prisma.report.count({ where: MODERATION_TAB_FILTER.REVIEW }),
      prisma.report.count({ where: MODERATION_TAB_FILTER.REJECT }),
    ]);

    return {
      reports: rows.map((r) => ({
        id: r.id,
        title: r.titleVi ?? r.title,
        createdAt: r.createdAt,
        detailAddress: r.detailAddress,
        riskScore: r.latestVerification?.riskScore ?? null,
        reasons: r.latestVerification?.reasons ?? [],
        thumbnailUrl: r.reportMediaFiles[0]?.media.url ?? null,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      counts: { review, autoRejected },
    };
  },

  /**
   * Moderator decision (specs/006 FR-039). Compare-and-set on the awaiting states, so of two
   * admins deciding at once the second gets 409. The owner is notified through the outbox.
   */
  async moderate(reportId: string, adminId: string, { decision, reasonCode, note }: ModerationDecision) {
    const now = new Date();
    const cleanNote = note?.trim() || null;

    return prisma.$transaction(async (tx) => {
      const changed = await tx.report.updateMany({
        where: { id: reportId, ...AWAITING_MODERATION },
        data:
          decision === "ACCEPT"
            ? { status: REPORT_STATUS_ACCEPTED, isVerify: true, rejectReason: null, moderationReasonCode: null, moderatedBy: adminId, moderatedAt: now }
            : { status: REPORT_STATUS_REJECTED, rejectReason: cleanNote, moderationReasonCode: reasonCode, moderatedBy: adminId, moderatedAt: now },
      });
      if (changed.count === 0) {
        const exists = await tx.report.count({ where: { id: reportId, deletedAt: null } });
        throw new HttpError(exists ? HTTP_STATUS.REPORT_ALREADY_MODERATED : HTTP_STATUS.REPORT_NOT_FOUND);
      }

      const report = await tx.report.findUniqueOrThrow({ where: { id: reportId } });
      await emitOutbox(tx, {
        aggregateType: "report",
        aggregateId: reportId,
        eventType: OutboxEventType.REPORT_VERIFIED,
        dedupKey: `REPORT_MODERATED:${reportId}:${now.toISOString()}`,
        payload: {
          reportId,
          userId: report.userId,
          reportTitle: report.titleVi ?? report.title ?? "",
          verificationId: report.latestVerificationId,
          reportStatus: report.status,
          statusChanged: true,
          flag: null,
          riskScore: null,
          source: "MODERATOR",
          rejectReason: cleanNote ?? "",
        },
      });
      return toReportResponse(report);
    });
  },
};
