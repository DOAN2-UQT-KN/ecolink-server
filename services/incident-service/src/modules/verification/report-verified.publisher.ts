import type { OutboxEventMessage, OutboxPublisher } from "../../outbox/outbox-publisher";
import {
  REPORT_STATUS_ACCEPTED,
  REPORT_STATUS_IN_REVIEW,
  REPORT_STATUS_REJECTED,
} from "../../constants/report-verification";
import {
  enqueueReportApprovedWebsiteNotification,
  enqueueReportInReviewWebsiteNotification,
  enqueueReportRejectedWebsiteNotification,
} from "../report/report-status-notify.client";

/** Subset of the REPORT_VERIFIED payload (contracts/events.md) this publisher reads. */
interface ReportVerifiedPayload {
  reportId?: string;
  userId?: string | null;
  reportTitle?: string;
  reportStatus?: number | null;
  statusChanged?: boolean;
  /** Moderator's note (source MODERATOR); empty for engine rejections. */
  rejectReason?: string;
}

/**
 * Turns REPORT_VERIFIED into the owner's in-app notification. Only status changes notify; a late
 * result that left the report untouched sends nothing. Throwing makes the relay retry.
 */
export class ReportVerifiedPublisher implements OutboxPublisher {
  async publish(event: OutboxEventMessage): Promise<void> {
    const p = (event.payload ?? {}) as ReportVerifiedPayload;
    if (p.statusChanged !== true || !p.userId || !p.reportId) return;

    const base = { userId: p.userId, reportId: p.reportId, reportTitle: p.reportTitle ?? "" };
    switch (p.reportStatus) {
      case REPORT_STATUS_ACCEPTED:
        return enqueueReportApprovedWebsiteNotification(base);
      case REPORT_STATUS_REJECTED:
        // Engine rejections carry no free-text reason; the template hides the line when empty.
        return enqueueReportRejectedWebsiteNotification({ ...base, rejectReason: p.rejectReason ?? "" });
      case REPORT_STATUS_IN_REVIEW:
        return enqueueReportInReviewWebsiteNotification(base);
      default:
        return;
    }
  }
}

export const reportVerifiedPublisher = new ReportVerifiedPublisher();
