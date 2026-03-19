import { reportVolunteerRepository } from "./report_volunteer.repository";
import { reportRepository } from "../report.repository";
import { JoinRequestStatus } from "../../../constants/status.enum";

// Request DTOs
export interface CreateJoinRequestRequest {
  reportId: string;
}

export interface UpdateJoinRequestRequest {
  status: JoinRequestStatus.APPROVED | JoinRequestStatus.REJECTED;
}

// Response DTOs
export interface JoinRequestResponse {
  id: string;
  reportId: string | null;
  volunteerId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface JoinRequestDetailResponse extends JoinRequestResponse {
  report?: {
    id: string;
    title: string | null;
    status: string | null;
  };
}

export class ReportVolunteerService {
  constructor() {}

  /**
   * Create a join request for a report
   */
  async createJoinRequest(
    reportId: string,
    volunteerId: string,
  ): Promise<JoinRequestResponse> {
    // Check if report exists
    const report = await reportRepository.findById(reportId);
    if (!report) {
      throw new Error("Report not found");
    }

    // Check if user is the reporter (can't join own report)
    if (report.userId === volunteerId) {
      throw new Error("Cannot join your own report");
    }

    // Check if already requested
    const existing = await reportVolunteerRepository.findExistingJoinRequest(
      reportId,
      volunteerId,
    );
    if (existing) {
      throw new Error("Join request already exists");
    }

    const request = await reportVolunteerRepository.createJoinRequest({
      reportId,
      volunteerId,
    });

    return {
      id: request.id,
      reportId: request.reportId,
      volunteerId: request.volunteerId,
      status: request.status,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    };
  }

  /**
   * Get join request by ID
   */
  async getJoinRequestById(
    id: string,
  ): Promise<JoinRequestDetailResponse | null> {
    const request =
      await reportVolunteerRepository.findJoinRequestByIdWithReport(id);
    if (!request) return null;

    return {
      id: request.id,
      reportId: request.reportId,
      volunteerId: request.volunteerId,
      status: request.status,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      report: request.report
        ? {
            id: request.report.id,
            title: request.report.title,
            status: request.report.status,
          }
        : undefined,
    };
  }

  /**
   * Get all join requests for a report
   */
  async getJoinRequestsByReportId(
    reportId: string,
  ): Promise<JoinRequestResponse[]> {
    const requests =
      await reportVolunteerRepository.findJoinRequestsByReportId(reportId);
    return requests.map((r) => ({
      id: r.id,
      reportId: r.reportId,
      volunteerId: r.volunteerId,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /**
   * Get all join requests by volunteer
   */
  async getMyJoinRequests(
    volunteerId: string,
  ): Promise<JoinRequestDetailResponse[]> {
    const requests =
      await reportVolunteerRepository.findJoinRequestsByVolunteerId(
        volunteerId,
      );
    return requests.map((r) => ({
      id: r.id,
      reportId: r.reportId,
      volunteerId: r.volunteerId,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      report: r.report
        ? {
            id: r.report.id,
            title: r.report.title,
            status: r.report.status,
          }
        : undefined,
    }));
  }

  /**
   * Approve or reject a join request
   * Only the reporter can approve/reject
   */
  async processJoinRequest(
    requestId: string,
    reporterId: string,
    status: JoinRequestStatus.APPROVED | JoinRequestStatus.REJECTED,
  ): Promise<JoinRequestResponse> {
    const request =
      await reportVolunteerRepository.findJoinRequestByIdWithReport(requestId);
    if (!request) {
      throw new Error("Join request not found");
    }

    // Check if user is the reporter
    if (request.report?.userId !== reporterId) {
      throw new Error("Only the reporter can approve/reject join requests");
    }

    // Check if already processed
    if (request.status !== JoinRequestStatus.PENDING) {
      throw new Error("Join request already processed");
    }

    const updated = await reportVolunteerRepository.updateJoinRequestStatus(
      requestId,
      status,
    );

    // TODO: Send notification to volunteer about the decision
    // await notificationService.notifyVolunteerAboutJoinRequestStatus(
    //     request.volunteerId,
    //     request.reportId,
    //     status
    // );

    return {
      id: updated.id,
      reportId: updated.reportId,
      volunteerId: updated.volunteerId,
      status: updated.status,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  /**
   * Cancel a join request (by volunteer)
   */
  async cancelJoinRequest(
    requestId: string,
    volunteerId: string,
  ): Promise<void> {
    const request =
      await reportVolunteerRepository.findJoinRequestById(requestId);
    if (!request) {
      throw new Error("Join request not found");
    }

    if (request.volunteerId !== volunteerId) {
      throw new Error("Cannot cancel another user's join request");
    }

    if (request.status !== JoinRequestStatus.PENDING) {
      throw new Error("Can only cancel pending requests");
    }

    await reportVolunteerRepository.softDeleteJoinRequest(requestId);
  }

  /**
   * Check if user is an approved volunteer for a report
   */
  async isApprovedVolunteer(
    reportId: string,
    volunteerId: string,
  ): Promise<boolean> {
    return reportVolunteerRepository.isVolunteerApproved(reportId, volunteerId);
  }

  /**
   * Get all approved volunteers for a report
   */
  async getApprovedVolunteers(
    reportId: string,
  ): Promise<{ volunteerId: string | null }[]> {
    const volunteers =
      await reportVolunteerRepository.getApprovedVolunteers(reportId);
    return volunteers.map((v) => ({ volunteerId: v.volunteerId }));
  }
}

// Singleton instance
export const reportVolunteerService = new ReportVolunteerService();
