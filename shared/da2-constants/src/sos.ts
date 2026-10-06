/**
 * SOS of a campaign (spec "Ecolink – Cải tiến tính năng SOS"): one of three types, raised by
 * someone at the scene of a running shift, sent to the campaign's team and then, by priority, to
 * nearby "available" volunteers, nearby organizations and the admins.
 */

export const SOS_TYPE = {
  /** People or tools needed. */
  MANPOWER: "manpower",
  /** Hazardous waste: never invites anyone over, only warns. */
  HAZARD: "hazard",
  /** Injury or accident. */
  MEDICAL: "medical",
} as const;
export type SosTypeValue = (typeof SOS_TYPE)[keyof typeof SOS_TYPE];
export const SOS_TYPES = Object.values(SOS_TYPE) as SosTypeValue[];

/** Lifecycle: open → helping → resolved; manpower may expire, hazard may go to the admins. */
export const SOS_STATE = {
  OPEN: "open",
  HELPING: "helping",
  RESOLVED: "resolved",
  EXPIRED: "expired",
  ESCALATED: "escalated",
} as const;
export type SosStateValue = (typeof SOS_STATE)[keyof typeof SOS_STATE];
/** Still shown on the map and still accepting help. */
export const SOS_LIVE_STATES: SosStateValue[] = [SOS_STATE.OPEN, SOS_STATE.HELPING, SOS_STATE.ESCALATED];

/** How the person raising it relates to the campaign. */
export const SOS_REPORTER_ROLE = {
  VOLUNTEER: "volunteer",
  LEADER: "leader",
  MANAGER: "manager",
  RESIDENT: "resident",
} as const;
export type SosReporterRoleValue = (typeof SOS_REPORTER_ROLE)[keyof typeof SOS_REPORTER_ROLE];

export const SOS_RESPONDER_STATUS = {
  ON_THE_WAY: "on_the_way",
  ARRIVED: "arrived",
  CANCELLED: "cancelled",
} as const;
export type SosResponderStatusValue = (typeof SOS_RESPONDER_STATUS)[keyof typeof SOS_RESPONDER_STATUS];

export const SOS_RESOLUTION_CODE = {
  HANDLED: "handled",
  /** Closed as a mistake: counts towards the abuse review. */
  FALSE_ALARM: "false_alarm",
  /** Closed as not real: counts towards the abuse review. */
  NOT_REAL: "not_real",
} as const;
export type SosResolutionCodeValue = (typeof SOS_RESOLUTION_CODE)[keyof typeof SOS_RESOLUTION_CODE];

/** Why someone cannot raise an SOS (`GET /sos/eligibility`). */
export const SOS_INELIGIBLE_REASON = {
  NOT_LOGGED: "not_logged",
  NO_RUNNING_SHIFT: "no_running_shift",
  NOT_CHECKED_IN: "not_checked_in",
  EMAIL_UNVERIFIED: "email_unverified",
  PHONE_MISSING: "phone_missing",
  TOO_FAR: "too_far",
  LOCATION_REQUIRED: "location_required",
} as const;
export type SosIneligibleReasonValue = (typeof SOS_INELIGIBLE_REASON)[keyof typeof SOS_INELIGIBLE_REASON];

export const SOS_MEDICAL_CONSCIOUSNESS = ["conscious", "unconscious"] as const;
export const SOS_TOOLS = ["truck", "bags", "shovel", "gloves", "rake", "other"] as const;
export const SOS_HAZARD_KINDS = [
  "needles",
  "chemicals",
  "medical_waste",
  "construction_debris",
  "other",
] as const;

/** SOS one person may raise per rolling hour. */
export const SOS_MAX_PER_HOUR = 3;
/** Manpower: people needed. */
export const SOS_PEOPLE_NEEDED_MIN = 1;
export const SOS_PEOPLE_NEEDED_MAX = 20;

/** A resident must be this close to a meeting point with a running shift. */
export const SOS_RESIDENT_RADIUS_M = 500;
/** A responder this close to the SOS has arrived. */
export const SOS_ARRIVED_RADIUS_M = 50;
/** An open SOS of the same type this close is suggested instead of a new one. */
export const SOS_DUPLICATE_RADIUS_M = 200;
/** "Available" volunteers are invited within this radius, widened after SOS_EXPAND_AFTER_MIN. */
export const SOS_INVITE_RADIUS_KM = 3;
export const SOS_INVITE_RADIUS_EXPANDED_KM = 5;
/** Other organizations with a meeting point (or their own location) this close are asked. */
export const SOS_NEARBY_ORG_RADIUS_KM = 5;

/** Manpower: widen the radius and ask nearby organizations when still short after this. */
export const SOS_EXPAND_AFTER_MIN = 15;
/** Manpower / hazard: tell the owners when nobody responded (still open) after this. */
export const SOS_OWNER_ESCALATE_MIN = 10;
/** Manpower: expires this long after creation (env SOS_MANPOWER_TTL_H, 3–6) or at its shift's end. */
export const SOS_MANPOWER_TTL_H = 4;
export const SOS_MANPOWER_TTL_H_MIN = 3;
export const SOS_MANPOWER_TTL_H_MAX = 6;
/** Hazard: handed to the admins when still not resolved after this. */
export const SOS_HAZARD_ESCALATE_H = 2;

/** SOS notifications an available volunteer gets per day from other campaigns (medical not counted). */
export const SOS_DAILY_INVITES = 5;
/** Closed as false alarm / not real this many times in SOS_ABUSE_WINDOW_DAYS: the admins review. */
export const SOS_ABUSE_THRESHOLD = 3;
export const SOS_ABUSE_WINDOW_DAYS = 30;
/** "Available" locations are rounded to about this precision (degrees, ~500 m). */
export const SOS_AVAILABILITY_ROUND_DEG = 0.005;
