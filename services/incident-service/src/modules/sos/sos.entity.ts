import { Campaign, Sos } from "@prisma/client";
import { SosCampaignResponse, SosResponse } from "./sos.dto";

export type SosEntity = Sos;

export const toSosCampaignResponse = (
  campaign: Campaign,
): SosCampaignResponse => ({
  id: campaign.id,
  title: campaign.title,
  banner: campaign.banner,
  description: campaign.description,
  status: campaign.status,
  startDate: campaign.startDate,
  endDate: campaign.endDate,
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
