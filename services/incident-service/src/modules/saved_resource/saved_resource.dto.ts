import type { SavedResourceType } from "../../constants/status.enum";

export interface SaveResourceBody {
  resourceId: string;
  resourceType: SavedResourceType;
}

export interface SaveResourceResponse {
  id: string;
  userId: string;
  resourceId: string;
  resourceType: SavedResourceType;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** OpenAPI: `data` for POST /saved-resources/save */
export interface SaveResourceEnvelopeData {
  savedResource: SaveResourceResponse;
}
