import { GlobalStatus } from "../../../constants/status.enum";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";
import { campaignJoiningRequestRepository } from "../campaign_joining_request/campaign_joining_request.repository";
import { campaignRepository } from "../campaign.repository";
import { campaignManagerService } from "../campaign_manager/campaign_manager.service";
import { campaignAttendanceRepository } from "./campaign_attendance.repository";
import {
  signCampaignAttendanceQrToken,
  verifyCampaignAttendanceQrToken,
} from "./campaign_attendance_jwt.util";

export class CampaignAttendanceService {
  async issueAttendanceQr(
    campaignId: string,
    managerUserId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const canManage = await campaignManagerService.canManageCampaign(
      campaignId,
      managerUserId,
    );
    if (!canManage) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "Only campaign managers can generate attendance QR",
        ),
      );
    }

    const campaign = await campaignRepository.findById(campaignId);
    if (!campaign) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
      );
    }
    if (campaign.status !== GlobalStatus._STATUS_ACTIVE) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "Attendance QR is only available for active campaigns",
        ),
      );
    }

    return signCampaignAttendanceQrToken(campaignId);
  }

  async checkInWithQrToken(
    campaignId: string,
    qrToken: string,
    userId: string,
  ): Promise<{ checkedInAt: Date; alreadyCheckedIn: boolean }> {
    const campaignIdFromToken = verifyCampaignAttendanceQrToken(qrToken);
    if (campaignIdFromToken !== campaignId) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "This QR code does not match this campaign",
        ),
      );
    }

    const campaign = await campaignRepository.findById(campaignId);
    if (!campaign) {
      throw new HttpError(
        HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
      );
    }
    if (campaign.status !== GlobalStatus._STATUS_ACTIVE) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "This campaign is not accepting check-in",
        ),
      );
    }

    const isApproved =
      await campaignJoiningRequestRepository.isVolunteerApproved(
        campaignId,
        userId,
      );
    if (!isApproved) {
      throw new HttpError(
        HTTP_STATUS.FORBIDDEN.withMessage(
          "You are not an approved member of this campaign",
        ),
      );
    }

    const existing = await campaignAttendanceRepository.findByCampaignAndUser(
      campaignId,
      userId,
    );
    if (existing) {
      return { checkedInAt: existing.checkedInAt, alreadyCheckedIn: true };
    }

    const created = await campaignAttendanceRepository.createCheckIn(
      campaignId,
      userId,
    );
    return { checkedInAt: created.checkedInAt, alreadyCheckedIn: false };
  }
}

export const campaignAttendanceService = new CampaignAttendanceService();
