import { HttpError, HTTP_STATUS } from "../../constants/http-status";
import { SavedResourceType } from "../../constants/status.enum";
import { campaignRepository } from "../campaign/campaign.repository";
import { reportRepository } from "../report/report.repository";
import { SaveResourceBody, SaveResourceResponse } from "./saved_resource.dto";
import { savedResourceRepository } from "./saved_resource.repository";

export class SavedResourceService {
  private async ensureSaveableResource(
    resourceType: SavedResourceType,
    resourceId: string,
  ): Promise<void> {
    if (resourceType === SavedResourceType.REPORT) {
      const report = await reportRepository.findById(resourceId);
      if (!report) {
        throw new HttpError(HTTP_STATUS.REPORT_NOT_FOUND);
      }
      return;
    }
    if (resourceType === SavedResourceType.CAMPAIGN) {
      const campaign = await campaignRepository.findById(resourceId);
      if (!campaign) {
        throw new HttpError(
          HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"),
        );
      }
      return;
    }
    throw new HttpError(HTTP_STATUS.INVALID_INPUT);
  }

  private toResponse(row: {
    id: string;
    userId: string;
    resourceId: string;
    resourceType: string;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }): SaveResourceResponse {
    return {
      id: row.id,
      userId: row.userId,
      resourceId: row.resourceId,
      resourceType: row.resourceType as SavedResourceType,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }

  /**
   * Toggle / upsert saved state: no row → create (saved). Row with deletedAt → restore.
   * Row already active (saved) → soft-delete (deletedAt = now).
   */
  async save(
    userId: string,
    body: SaveResourceBody,
  ): Promise<SaveResourceResponse> {
    await this.ensureSaveableResource(body.resourceType, body.resourceId);

    const existing = await savedResourceRepository.findByUserAndResource(
      userId,
      body.resourceType,
      body.resourceId,
    );

    if (!existing) {
      const created = await savedResourceRepository.create(
        userId,
        body.resourceType,
        body.resourceId,
      );
      return this.toResponse(created);
    }

    if (existing.deletedAt != null) {
      const restored = await savedResourceRepository.restore(existing.id);
      return this.toResponse(restored);
    }

    const removed = await savedResourceRepository.softDelete(existing.id);
    return this.toResponse(removed);
  }
}

export const savedResourceService = new SavedResourceService();
