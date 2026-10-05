import axios, { AxiosInstance } from "axios";
import type { OrganizationOwnerResponse } from "./organization.dto";
import {
  getHttpCircuit,
  HTTP_CIRCUIT_IDENTITY,
} from "../../resilience/http-circuit";

function identityCircuit() {
  return getHttpCircuit(HTTP_CIRCUIT_IDENTITY);
}

/** Current circuit state for identity HTTP calls (health / tests). */
export function getIdentityHttpCircuitState(): string {
  return identityCircuit().getState();
}

function getClient(): AxiosInstance {
  const baseURL = process.env.IDENTITY_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_IDENTITY_API_KEY?.trim();
  if (!baseURL || !key) {
    throw new Error(
      "IDENTITY_SERVICE_URL and INTERNAL_IDENTITY_API_KEY must be configured to load organization owners",
    );
  }
  return axios.create({
    baseURL: baseURL.replace(/\/$/, ""),
    timeout: 10_000,
    headers: { "x-internal-api-key": key },
  });
}

interface SuccessEnvelope<T> {
  success?: boolean;
  data?: T;
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function pickNullableString(v: unknown): string | null {
  if (v === null) return null;
  const s = pickString(v);
  return s !== undefined ? s : null;
}

/**
 * Scalars may arrive as non-strings (e.g. legacy clients); coerce for display fields.
 */
function pickFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (v != null && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Identity internal responses use snake_case (`caseTransformMiddleware`). */
function pickUserIdsFromEnvelope(inner: unknown): string[] {
  if (!inner || typeof inner !== "object") {
    return [];
  }
  const raw =
    (inner as Record<string, unknown>).userIds ??
    (inner as Record<string, unknown>).user_ids;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function pickDisplayString(
  value: unknown,
  ...alts: Array<unknown>
): string {
  const candidates: unknown[] = [value, ...alts];
  for (const v of candidates) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") {
      return String(v);
    }
  }
  return "";
}

/**
 * `fetchOrganizationOwnersByUserIds` stores entries under **lowercase** user id keys
 * (UUIDs are case-insensitive, but `Map` lookups are not).
 */
export function getUserProfile(
  m: ReadonlyMap<string, OrganizationOwnerResponse>,
  userId: string,
): OrganizationOwnerResponse | undefined {
  return m.get(userId.toLowerCase().trim());
}

function mapKeyForUserId(userId: string): string {
  return userId.toLowerCase().trim();
}

function getUsersArrayFromResponse(data: unknown): unknown[] | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const root = data as Record<string, unknown>;
  if (root.success === false) {
    return null;
  }
  const inner = root.data;
  if (inner && typeof inner === "object") {
    const u = (inner as { users?: unknown }).users;
    if (Array.isArray(u)) {
      return u;
    }
  }
  const top = root.users;
  if (Array.isArray(top)) {
    return top;
  }
  return null;
}

const INTERNAL_USERS_BY_IDS_MAX = 100;

/**
 * RFC 4122 UUID accepted by identity-service `body("*.isUUID")` (validator.js).
 * Seed/fixture ids are often UUID-shaped but invalid; one bad id fails the whole batch with 400.
 */
const IDENTITY_INTERNAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isIdentityCallableUserId(id: string): boolean {
  return IDENTITY_INTERNAL_UUID_RE.test(id.trim());
}

export function filterUserIdsForIdentityInternalApi(
  userIds: string[],
): string[] {
  return [
    ...new Set(
      userIds
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id) => id.length > 0 && isIdentityCallableUserId(id)),
    ),
  ];
}

/** Name + email from identity internal `/users/by-ids` (server-side only). */
export interface IdentityUserContact {
  id: string;
  name: string;
  email: string | null;
}

function readIdentityContactFromRow(raw: unknown): IdentityUserContact | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const id = pickString(row.id) ?? pickString(row.user_id);
  if (!id) {
    return null;
  }
  const name = pickDisplayString(
    row.name,
    row.user_name,
    row.display_name,
    row.full_name,
  );
  const emailRaw =
    pickNullableString(row.email) ??
    pickNullableString(row.user_email) ??
    pickNullableString(row.userEmail);
  const email =
    emailRaw && emailRaw.includes("@") ? emailRaw.trim().toLowerCase() : null;
  return {
    id,
    name,
    email,
  };
}

export function getIdentityUserContact(
  m: ReadonlyMap<string, IdentityUserContact>,
  userId: string,
): IdentityUserContact | undefined {
  return m.get(userId.toLowerCase().trim());
}

/**
 * Batch-load users with **email** (internal). Same transport as
 * `fetchOrganizationOwnersByUserIds`; map keys are lowercase user ids.
 */
export async function fetchIdentityUsersWithContactByIds(
  userIds: string[],
): Promise<Map<string, IdentityUserContact>> {
  const unique = filterUserIdsForIdentityInternalApi(userIds);
  const out = new Map<string, IdentityUserContact>();
  if (unique.length === 0) {
    return out;
  }

  try {
    await identityCircuit().run(async () => {
      const client = getClient();
      for (let i = 0; i < unique.length; i += INTERNAL_USERS_BY_IDS_MAX) {
        const chunk = unique.slice(i, i + INTERNAL_USERS_BY_IDS_MAX);
        const { data } = await client.post<SuccessEnvelope<{ users?: unknown }>>(
          "/internal/v1/users/by-ids",
          { ids: chunk },
        );
        const users = getUsersArrayFromResponse(data);
        if (users === null) {
          throw new Error("Identity service did not return users");
        }
        for (const raw of users) {
          const row = readIdentityContactFromRow(raw);
          if (!row) {
            continue;
          }
          out.set(mapKeyForUserId(row.id), row);
        }
      }
    });
  } catch (e) {
    console.error(
      "[identity-user.client] fetchIdentityUsersWithContactByIds:",
      e,
    );
  }
  return out;
}

function readProfileFromRow(
  raw: unknown,
): OrganizationOwnerResponse | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const id = pickString(row.id) ?? pickString(row.user_id);
  if (!id) {
    return null;
  }
  const name = pickDisplayString(
    row.name,
    row.user_name,
    row.display_name,
    row.full_name,
  );
  const avatar = pickNullableString(row.avatar) ?? pickNullableString(row.avatar_url);
  const bio = pickNullableString(row.bio);
  return {
    id,
    name,
    avatar,
    bio,
  };
}

/**
 * Loads user profiles from identity-service (internal batch).
 * Outbound JSON may use snake_case (identity `caseTransformMiddleware` on nested keys
 * like `role_id`); this parser accepts `id` / `name` / `avatar` and common alternates.
 * Map keys are **lowercase** user ids; use `getUserProfile(map, id)` to look up.
 */
export async function fetchOrganizationOwnersByUserIds(
  userIds: string[],
): Promise<Map<string, OrganizationOwnerResponse>> {
  const unique = filterUserIdsForIdentityInternalApi(userIds);
  const out = new Map<string, OrganizationOwnerResponse>();
  if (unique.length === 0) {
    return out;
  }

  try {
    await identityCircuit().run(async () => {
      const client = getClient();
      for (let i = 0; i < unique.length; i += INTERNAL_USERS_BY_IDS_MAX) {
        const chunk = unique.slice(i, i + INTERNAL_USERS_BY_IDS_MAX);
        const { data } = await client.post<SuccessEnvelope<{ users?: unknown }>>(
          "/internal/v1/users/by-ids",
          { ids: chunk },
        );
        const users = getUsersArrayFromResponse(data);
        if (users === null) {
          throw new Error("Identity service did not return users");
        }
        for (const raw of users) {
          const profile = readProfileFromRow(raw);
          if (!profile) {
            continue;
          }
          out.set(mapKeyForUserId(profile.id), profile);
        }
      }
    });
  } catch (e) {
    console.error("[identity-user.client] fetchOrganizationOwnersByUserIds:", e);
  }
  return out;
}

export interface UserDistanceFromPointRow {
  id: string;
  email: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  distanceMeters: number | null;
}

/** All active users and distance (m) from a point; null distance if no saved location. */
export async function fetchUsersWithDistanceFromPoint(params: {
  latitude: number;
  longitude: number;
}): Promise<UserDistanceFromPointRow[]> {
  const baseURL = process.env.IDENTITY_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_IDENTITY_API_KEY?.trim();
  if (!baseURL || !key) {
    return [];
  }

  try {
    return await identityCircuit().run(async () => {
      const client = axios.create({
        baseURL: baseURL.replace(/\/$/, ""),
        timeout: 10_000,
        headers: { "x-internal-api-key": key },
      });

      const { data } = await client.post<
        SuccessEnvelope<{ users?: unknown }>
      >("/internal/v1/users/distance-from-point", {
        latitude: params.latitude,
        longitude: params.longitude,
      });

      const inner = data?.data;
      const raw =
        inner && typeof inner === "object"
          ? (inner as { users?: unknown }).users
          : undefined;
      if (!Array.isArray(raw)) {
        return [];
      }

      const out: UserDistanceFromPointRow[] = [];
      for (const row of raw) {
        if (!row || typeof row !== "object") {
          continue;
        }
        const r = row as Record<string, unknown>;
        const id = typeof r.id === "string" ? r.id : "";
        if (!id) {
          continue;
        }
        out.push({
          id,
          email: typeof r.email === "string" ? r.email : "",
          name: typeof r.name === "string" ? r.name : "",
          latitude: pickFiniteNumber(r.latitude),
          longitude: pickFiniteNumber(r.longitude),
          distanceMeters: pickFiniteNumber(
            r.distanceMeters ?? r.distance_meters,
          ),
        });
      }
      return out;
    });
  } catch (e) {
    console.error("[identity-user.client] fetchUsersWithDistanceFromPoint:", e);
    return [];
  }
}

/**
 * Users who saved a last-known location within `radiusMeters` of the point (identity-service).
 */
export async function fetchUserIdsNearPoint(params: {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  excludeUserIds?: string[];
}): Promise<string[]> {
  const baseURL = process.env.IDENTITY_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_IDENTITY_API_KEY?.trim();
  if (!baseURL || !key) {
    console.warn(
      "[identity-user.client] fetchUserIdsNearPoint: IDENTITY_SERVICE_URL or INTERNAL_IDENTITY_API_KEY not set",
    );
    return [];
  }

  const excludeUserIds = filterUserIdsForIdentityInternalApi(
    params.excludeUserIds ?? [],
  );

  try {
    return await identityCircuit().run(async () => {
      const client = axios.create({
        baseURL: baseURL.replace(/\/$/, ""),
        timeout: 10_000,
        headers: { "x-internal-api-key": key },
      });

      const { data } = await client.post<
        SuccessEnvelope<{ userIds?: unknown }>
      >("/internal/v1/users/nearby-ids", {
        latitude: params.latitude,
        longitude: params.longitude,
        radiusMeters: params.radiusMeters,
        excludeUserIds,
      });

      return pickUserIdsFromEnvelope(data?.data);
    });
  } catch (e) {
    console.error("[identity-user.client] fetchUserIdsNearPoint:", e);
    return [];
  }
}

const INTERNAL_NOTIFICATION_FILTER_MAX = 500;

/**
 * Returns subset of `userIds` that have not opted out of `kind` (identity internal).
 * On misconfiguration or error, returns all input ids (fail-open for delivery).
 */
export async function filterUserIdsForNotificationKind(params: {
  userIds: string[];
  kind: string;
}): Promise<string[]> {
  const unique = filterUserIdsForIdentityInternalApi(params.userIds);
  if (unique.length === 0) {
    return [];
  }

  const baseURL = process.env.IDENTITY_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_IDENTITY_API_KEY?.trim();
  if (!baseURL || !key) {
    console.warn(
      "[identity-user.client] filterUserIdsForNotificationKind: identity env not set; skipping filter",
    );
    return unique;
  }

  try {
    return await identityCircuit().run(async () => {
      const client = axios.create({
        baseURL: baseURL.replace(/\/$/, ""),
        timeout: 10_000,
        headers: { "x-internal-api-key": key },
      });

      const enabled: string[] = [];
      for (let i = 0; i < unique.length; i += INTERNAL_NOTIFICATION_FILTER_MAX) {
        const chunk = unique.slice(i, i + INTERNAL_NOTIFICATION_FILTER_MAX);
        const { data } = await client.post<
          SuccessEnvelope<{ userIds?: unknown }>
        >("/internal/v1/users/notification-prefs/filter", {
          userIds: chunk,
          kind: params.kind,
        });
        for (const id of pickUserIdsFromEnvelope(data?.data)) {
          enabled.push(id);
        }
      }
      return enabled;
    });
  } catch (e) {
    console.error(
      "[identity-user.client] filterUserIdsForNotificationKind:",
      e,
    );
    return unique;
  }
}

/** What a result-verification vote's weight depends on (identity `POST /users/vote-profile`). */
export interface UserVoteProfile {
  createdAt: Date;
  emailVerified: boolean;
  /** Metres from the saved location to the point; null without a saved location. */
  savedLocationDistanceM: number | null;
}

/**
 * The voter's account age, email verification and saved-location distance to a trash point.
 * Null when identity is not configured, unreachable or does not know the user: the caller
 * refuses the vote rather than guessing its weight.
 */
export async function fetchUserVoteProfile(params: {
  userId: string;
  latitude: number;
  longitude: number;
}): Promise<UserVoteProfile | null> {
  const baseURL = process.env.IDENTITY_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_IDENTITY_API_KEY?.trim();
  if (!baseURL || !key) {
    console.warn("[identity-user.client] fetchUserVoteProfile: identity env not set");
    return null;
  }
  try {
    return await identityCircuit().run(async () => {
      const client = axios.create({
        baseURL: baseURL.replace(/\/$/, ""),
        timeout: 10_000,
        headers: { "x-internal-api-key": key },
      });
      const { data } = await client.post<SuccessEnvelope<Record<string, unknown>>>(
        "/internal/v1/users/vote-profile",
        { userId: params.userId, latitude: params.latitude, longitude: params.longitude },
      );
      const inner = data?.data;
      if (!inner || typeof inner !== "object") return null;
      const created = new Date(String(inner.createdAt ?? inner.created_at ?? ""));
      if (Number.isNaN(created.getTime())) return null;
      return {
        createdAt: created,
        emailVerified: (inner.emailVerified ?? inner.email_verified) === true,
        savedLocationDistanceM: pickFiniteNumber(
          inner.savedLocationDistanceM ?? inner.saved_location_distance_m,
        ),
      };
    });
  } catch (e) {
    console.error("[identity-user.client] fetchUserVoteProfile:", e);
    return null;
  }
}
