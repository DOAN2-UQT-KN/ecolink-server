export interface CreateSosRequest {
  /** ID of the campaign this SOS belongs to. Mapped from campaign_id. */
  campaignId: string;
  content: string;
  phone: string;
}

export interface SosResponse {
  id: number;
  campaignId: string;
  content: string;
  phone: string;
  address: string;
  detailAddress: string | null;
  latitude: number;
  longitude: number;
  status: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SosWithDistance extends SosResponse {
  /** Distance from query point in metres. */
  distanceMetres: number;
}

export interface SosOneEnvelopeData {
  sos: SosResponse;
}

export interface SosListEnvelopeData {
  sos: SosResponse[];
}

export interface SosListQuery {
  campaignId?: string;
  status?: number;
  /** Viewer latitude for distance sorting / filtering. */
  latitude?: number;
  /** Viewer longitude for distance sorting / filtering. */
  longitude?: number;
  /** Max distance in metres (requires latitude & longitude). */
  maxDistance?: number;
  page?: number;
  limit?: number;
}

export interface PaginatedSosEnvelopeData {
  sos: SosResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
