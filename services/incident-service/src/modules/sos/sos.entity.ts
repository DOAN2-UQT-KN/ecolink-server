import { Sos } from "@prisma/client";
import { campaignSpan, type CampaignWithReports } from "../campaign/campaign.entity";
import { SosCampaignResponse, SosResponse } from "./sos.dto";

export type SosEntity = Sos;

export const toSosCampaignResponse = (
  campaign: CampaignWithReports,
): SosCampaignResponse => ({
  id: campaign.id,
  title: campaign.title,
  banner: campaign.banner,
  description: campaign.description,
  status: campaign.status,
  // First start and last end of the campaign's days.
  startDate: campaignSpan(campaign.days)?.startAt ?? null,
  endDate: campaignSpan(campaign.days)?.endAt ?? null,
  detailAddress: campaign.detailAddress,
  latitude: campaign.latitude,
  longitude: campaign.longitude,
  radiusKm: campaign.radiusKm,
  difficulty: campaign.difficulty,
  organizationId: campaign.organizationId,
  createdBy: campaign.createdBy,
  updatedBy: campaign.updatedBy,
  createdAt: campaign.createdAt,
  updatedAt: campaign.updatedAt,
});

export const toSosResponse = (entity: SosEntity): SosResponse => ({
  id: entity.id,
  campaignId: entity.campaignId,
  content: entity.content,
  phone: entity.phone,
  address: entity.address,
  detailAddress: entity.detailAddress,
  latitude: entity.latitude,
  longitude: entity.longitude,
  status: entity.status,
  createdBy: entity.createdBy,
  updatedBy: entity.updatedBy,
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
});
