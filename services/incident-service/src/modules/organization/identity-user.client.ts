import axios, { AxiosInstance } from "axios";
import type { OrganizationOwnerResponse } from "./organization.dto";

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
  const unique = [
    ...new Set(userIds.map((id) => id?.trim()).filter(Boolean)),
  ] as string[];
  const out = new Map<string, IdentityUserContact>();
  if (unique.length === 0) {
    return out;
  }

  try {
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
  const unique = [
    ...new Set(userIds.map((id) => id?.trim()).filter(Boolean)),
  ] as string[];
  const out = new Map<string, OrganizationOwnerResponse>();
  if (unique.length === 0) {
    return out;
  }

  try {
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
  } catch (e) {
    console.error("[identity-user.client] fetchOrganizationOwnersByUserIds:", e);
  }
  return out;
}
