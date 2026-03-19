import { reportManagerRepository } from "./report_manager.repository";
import { reportRepository } from "../report.repository";
import { ReportManagerResponse, AddManagersRequest } from "../report.dto";

export class ReportManagerService {
  constructor() {}

  /**
   * Add multiple managers to a report
   * Both reporter and managers can add managers
   */
  async addManagers(
    reportId: string,
    request: AddManagersRequest,
    assignedBy: string,
  ): Promise<ReportManagerResponse[]> {
    // Check if report exists
    const report = await reportRepository.findById(reportId);
    if (!report) {
      throw new Error("Report not found");
    }

    // Check if assigner is the reporter or a manager
    const canManage = await this.canManageReport(reportId, assignedBy);
    if (!canManage) {
      throw new Error("Only the reporter or managers can assign managers");
    }

    const addedManagers: ReportManagerResponse[] = [];

    for (const userId of request.userIds) {
      // Check if already a manager
      const existing = await reportManagerRepository.findByReportIdAndUserId(
        reportId,
        userId,
      );
      if (existing) {
        // Skip already existing managers
        continue;
      }

      const manager = await reportManagerRepository.assignManager({
        reportId,
        userId,
        assignedBy,
      });

      addedManagers.push({
        reportId: manager.reportId,
        userId: manager.userId,
        assignedBy: manager.assignedBy,
        assignedAt: manager.assignedAt,
      });
    }

    // TODO: Send notification to the assigned managers
    // for (const manager of addedManagers) {
    //   await notificationService.notifyManagerAssignment(manager.userId, reportId);
    // }

    return addedManagers;
  }

  /**
   * Remove a manager from a report
   * Only the reporter can remove managers
   */
  async removeManager(
    reportId: string,
    userId: string,
    removedBy: string,
  ): Promise<void> {
    // Check if report exists
    const report = await reportRepository.findById(reportId);
    if (!report) {
      throw new Error("Report not found");
    }

    // Check if remover is the reporter
    if (report.userId !== removedBy) {
      throw new Error("Only the reporter can remove managers");
    }

    // Check if user is a manager
    const existing = await reportManagerRepository.findByReportIdAndUserId(
      reportId,
      userId,
    );
    if (!existing) {
      throw new Error("User is not a manager for this report");
    }

    await reportManagerRepository.removeManager(reportId, userId);
  }

  /**
   * Get all managers for a report
   */
  async getReportManagers(reportId: string): Promise<ReportManagerResponse[]> {
    // Check if report exists
    const report = await reportRepository.findById(reportId);
    if (!report) {
      throw new Error("Report not found");
    }

    const managers =
      await reportManagerRepository.findManagersByReportId(reportId);
    return managers.map((m) => ({
      reportId: m.reportId,
      userId: m.userId,
      assignedBy: m.assignedBy,
      assignedAt: m.assignedAt,
    }));
  }

  /**
   * Check if user is a manager for a report
   */
  async isManager(reportId: string, userId: string): Promise<boolean> {
    return reportManagerRepository.isManager(reportId, userId);
  }

  /**
   * Check if user can manage a report (is reporter or manager)
   */
  async canManageReport(reportId: string, userId: string): Promise<boolean> {
    const report = await reportRepository.findById(reportId);
    if (!report) return false;

    // Reporter can always manage
    if (report.userId === userId) return true;

    // Check if user is a manager
    return reportManagerRepository.isManager(reportId, userId);
  }

  /**
   * Get all reports managed by a user
   */
  async getMyManagedReports(userId: string) {
    const managers =
      await reportManagerRepository.findReportsByManagerId(userId);
    return managers.map((m) => ({
      reportId: m.reportId,
      userId: m.userId,
      assignedBy: m.assignedBy,
      assignedAt: m.assignedAt,
      createdAt: m.createdAt,
      report: m.report
        ? {
            id: m.report.id,
            title: m.report.title,
            status: m.report.status,
          }
        : undefined,
    }));
  }
}

// Singleton instance
export const reportManagerService = new ReportManagerService();
