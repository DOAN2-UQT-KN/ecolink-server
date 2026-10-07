import type {
  SosIneligibleReasonValue,
  SosReporterRoleValue,
  SosResolutionCodeValue,
  SosResponderStatusValue,
  SosStateValue,
  SosTypeValue,
} from "@da2/constants";

/** Per type; stored as JSON on the SOS (keys snake_cased on the way out). */
export interface SosManpowerDetails {
  peopleNeeded: number | null;
  tools: string[];
  toolsNote: string | null;
}
export interface SosHazardDetails {
  /** One or more of `SOS_HAZARD_KINDS`. */
  hazardKinds: string[];
}
export interface SosMedicalDetails {
  consciousness: "conscious" | "unconscious" | null;
  affected: number | null;
}
export type SosDetails = SosManpowerDetails | SosHazardDetails | SosMedicalDetails;

/** Body of `POST /sos` (camelCased by `camelCaseRequestBody`). */
export interface CreateSosRequest {
  campaignId: string;
  shiftId?: string;
  type: SosTypeValue;
  details: Record<string, unknown>;
  description?: string;
  photoUrls?: string[];
  latitude?: number;
  longitude?: number;
  accuracy?: number;
}

export interface SosActor {
  userId: string;
  role?: string | null;
}

/** A running shift someone may raise an SOS for. */
export interface SosShiftOption {
  id: string;
  name: string;
  meetingPointId: string;
  meetingPointName: string | null;
  startAt: Date;
  endAt: Date;
}

export interface SosEligibility {
  canRaise: boolean;
  role: SosReporterRoleValue | null;
  reason: SosIneligibleReasonValue | null;
  shifts: SosShiftOption[];
  /** null: no hourly limit. */
  hourlyRemaining: number | null;
}

/**
 * One row of the map / list: position, type, state, the counter and the closing fields for
 * anyone; `reporter` and `phone` only for an admin or the SOS's team (null for everyone else).
 */
export interface SosSummary {
  id: number;
  campaignId: string;
  campaignTitle: string;
  shiftId: string | null;
  meetingPointId: string | null;
  type: SosTypeValue;
  state: SosStateValue;
  /** Legacy numeric status: 1 while live, 17 once closed. */
  status: number;
  latitude: number;
  longitude: number;
  createdAt: Date;
  peopleNeeded: number | null;
  onTheWayCount: number;
  arrivedCount: number;
  isMine: boolean;
  myResponse: "on_the_way" | "arrived" | null;
  reporterRole: SosReporterRoleValue | null;
  resolvedAt: Date | null;
  resolutionCode: SosResolutionCodeValue | null;
  /** Admin or the SOS's team only. */
  phone: string | null;
  /** Admin or the SOS's team only. */
  reporter: { id: string; name: string | null; avatar: string | null } | null;
}

export interface SosResponderView {
  userId: string;
  name: string | null;
  avatar: string | null;
  status: SosResponderStatusValue;
  updatedAt: Date;
}

export interface SosPermissions {
  canRespond: boolean;
  canCancelResponse: boolean;
  canUpdateLocation: boolean;
  canResolve: boolean;
}

/** `GET /sos/:id`, filtered by who is looking (spec "Quyền riêng tư"). */
export interface SosDetail extends SosSummary {
  campaign: {
    id: string;
    title: string;
    contactName: string | null;
    contactPhone: string | null;
    safetyNotes: string | null;
  };
  shift: { id: string; name: string; startAt: Date; endAt: Date } | null;
  meetingPoint: { id: string; name: string | null; latitude: number; longitude: number } | null;
  details: Record<string, unknown>;
  description: string | null;
  photoUrls: string[];
  responders: SosResponderView[];
  expiresAt: Date | null;
  escalatedAt: Date | null;
  radiusKm: number;
  resolvedBy: string | null;
  resolutionNote: string | null;
  locationUpdatedAt: Date | null;
  permissions: SosPermissions;
  viewerIsTeam: boolean;
}

export interface SosListQuery {
  campaignId?: string;
  /** `states=all` arrives here as every state. */
  states: SosStateValue[];
  type?: SosTypeValue;
  /** Campaign title (case-insensitive), or the SOS id when it is a whole number. */
  search?: string;
  latitude?: number;
  longitude?: number;
  /** Metres; only with latitude and longitude. */
  maxDistance?: number;
  page: number;
  limit: number;
}

export interface SosListResult {
  items: SosSummary[];
  /** Same rows as `items`, under the key the map used before SOS v2. */
  sos: SosSummary[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** One weekly window of "Sẵn sàng"; days 0 = Sunday … 6, times local "HH:mm". */
export interface AvailabilityWindow {
  days: number[];
  from: string;
  to: string;
}

export interface AvailabilityView {
  enabled: boolean;
  schedule: AvailabilityWindow[];
  locationUpdatedAt: Date | null;
}
