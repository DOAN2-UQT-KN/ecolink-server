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

/** OpenAPI: `data` for POST /incident/saved-resources/save */
export interface SaveResourceEnvelopeData {
  savedResource: SaveResourceResponse;
}

/** Query for GET /incident/saved-resources (current user’s saved list). */
export interface SavedResourceListQuery {
  page?: number;
  limit?: number;
  /** If set, only rows for this resource type. */
  resourceType?: SavedResourceType;
  sortBy?: "createdAt" | "updatedAt";
  sortOrder?: "asc" | "desc";
}

export interface PaginatedSavedResourcesResponse {
  savedResources: SaveResourceResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** OpenAPI: `data` for GET /incident/saved-resources */
export type SavedResourcesListEnvelopeData = PaginatedSavedResourcesResponse;
