import prisma from "../../config/prisma.client";
import { HttpError, HTTP_STATUS } from "../../constants/http-status";
import { toAdminView, toUserView } from "./verification.presenter";
import { verificationQueryService } from "./verification-query.service";

async function findReport(reportId: string) {
  const report = await prisma.report.findFirst({
    where: { id: reportId, deletedAt: null },
    select: { id: true, userId: true, status: true, moderatedBy: true, moderatedAt: true, moderationReasonCode: true },
  });
  if (!report) throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
  return report;
}

/** Latest verification of a report: owner gets the public view, admin the full view (specs/006 P09). */
export const verificationViewService = {
  async getForViewer(reportId: string, viewer: { userId: string; isAdmin: boolean }) {
    const report = await findReport(reportId);
    if (!viewer.isAdmin && report.userId !== viewer.userId) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage("Only the report owner or an admin can view its verification"),
      );
    }
    const latest = await verificationQueryService.findLatest(reportId);
    if (!latest) throw new HttpError(HTTP_STATUS.VERIFICATION_NOT_FOUND);
    return viewer.isAdmin ? toAdminView(latest, report) : toUserView(latest, report);
  },

  async listForAdmin(reportId: string) {
    const report = await findReport(reportId);
    const all = await verificationQueryService.findAll(reportId);
    return all.map((v) => toAdminView(v, report));
  },
};
