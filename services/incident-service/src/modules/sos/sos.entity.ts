import { Sos } from "@prisma/client";
import { SosResponse } from "./sos.dto";

export type SosEntity = Sos;

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
