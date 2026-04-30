import { GlobalStatus } from "../../constants/status.enum";
import { HttpError } from "../../constants/http-status";
import { HTTP_STATUS } from "../../constants/http-status";
import { campaignRepository } from "../campaign/campaign.repository";
import { sosRepository } from "./sos.repository";
import { toSosCampaignResponse, toSosResponse } from "./sos.entity";
import type {
  CreateSosRequest,
  PaginatedSosEnvelopeData,
  SosListQuery,
  SosResponse,
  SosWithDistance,
} from "./sos.dto";

/** Regex: 7–15 digits, optional leading +. */
const PHONE_REGEX = /^\+?\d{7,15}$/;

export class SosService {
  private async withCampaignDetails<T extends { campaignId: string }>(
    sosRows: T[],
  ): Promise<(T & { campaign: ReturnType<typeof toSosCampaignResponse> | null })[]> {
    const campaignIds = [...new Set(sosRows.map((row) => row.campaignId))];
    const campaigns = await campaignRepository.findManyByIds(campaignIds);
    const campaignMap = new Map(
      campaigns.map((campaign) => [campaign.id, toSosCampaignResponse(campaign)]),
    );

    return sosRows.map((row) => ({
      ...row,
      campaign: campaignMap.get(row.campaignId) ?? null,
    }));
  }

  async create(
    body: CreateSosRequest,
    createdBy?: string,
  ): Promise<SosResponse> {
    const { campaignId, content, phone } = body;

    if (!PHONE_REGEX.test(phone)) {
      throw new HttpError(
        HTTP_STATUS.VALIDATION_ERROR.withMessage(
          "Invalid phone number format. Must be 7–15 digits, optional leading +.",
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
          "SOS can only be created for an active campaign",
        ),
      );
    }

    if (campaign.latitude == null || campaign.longitude == null) {
      throw new HttpError(
        HTTP_STATUS.BAD_REQUEST.withMessage(
          "Campaign does not have location coordinates",
        ),
      );
    }

    const sos = await sosRepository.create({
      campaign: { connect: { id: campaignId } },
      content: content.trim(),
      phone: phone.trim(),
      address: campaign.detailAddress ?? "",
      detailAddress: campaign.detailAddress,
      latitude: campaign.latitude,
      longitude: campaign.longitude,
      status: GlobalStatus._STATUS_ACTIVE,
      ...(createdBy ? { createdBy } : {}),
    });

    return toSosResponse(sos);
  }

  async list(
    query: SosListQuery,
  ): Promise<PaginatedSosEnvelopeData> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    if (query.latitude !== undefined && query.longitude !== undefined) {
      const maxDistanceMetres = query.maxDistance ?? 50_000;
      const { rows, total } = await sosRepository.findNearby({
        latitude: query.latitude,
        longitude: query.longitude,
        maxDistanceMetres,
        campaignId: query.campaignId,
        status: query.status,
        skip,
        take: limit,
      });

      return {
        sos: (await this.withCampaignDetails(rows)).map((row) => ({
          ...toSosResponse(row),
          campaign: row.campaign,
        })),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    }

    const { rows, total } = await sosRepository.findMany({
      campaignId: query.campaignId,
      status: query.status,
      skip,
      take: limit,
    });

    return {
      sos: (await this.withCampaignDetails(rows)).map((row) => ({
        ...toSosResponse(row),
        campaign: row.campaign,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async listNearby(
    latitude: number,
    longitude: number,
    query: SosListQuery,
  ): Promise<(SosWithDistance & { distanceMetres: number })[]> {
    const maxDistanceMetres = query.maxDistance ?? 50_000;
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const { rows } = await sosRepository.findNearby({
      latitude,
      longitude,
      maxDistanceMetres,
      campaignId: query.campaignId,
      status: query.status,
      skip: (page - 1) * limit,
      take: limit,
    });
    return (await this.withCampaignDetails(rows)).map((r) => ({
      ...toSosResponse(r),
      campaign: r.campaign,
      distanceMetres: r.distanceMetres,
    }));
  }

  async solveSos(id: number, updatedBy?: string): Promise<SosResponse> {
    const existing = await sosRepository.findById(id);
    if (!existing) {
      throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("SOS not found"));
    }

    if (existing.status === GlobalStatus._STATUS_COMPLETED) {
      return toSosResponse(existing);
    }

    const updated = await sosRepository.update(id, {
      status: GlobalStatus._STATUS_COMPLETED,
      ...(updatedBy ? { updatedBy } : {}),
    });

    return toSosResponse(updated);
  }

  /** Resolve all SOS for a campaign. Called internally when campaign is marked done. */
  async resolveAllByCampaignId(
    campaignId: string,
    updatedBy: string,
  ): Promise<void> {
    await sosRepository.resolveAllByCampaignId(
      campaignId,
      updatedBy,
      GlobalStatus._STATUS_COMPLETED,
    );
  }
}

export const sosService = new SosService();
