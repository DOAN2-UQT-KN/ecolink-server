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
 * Loads owner profiles from identity-service (internal batch). Wire format uses snake_case keys.
 * On failure or missing users, returns a partial map; callers should fall back per `ownerId`.
 */
const INTERNAL_USERS_BY_IDS_MAX = 100;

export async function fetchOrganizationOwnersByUserIds(
  userIds: string[],
): Promise<Map<string, OrganizationOwnerResponse>> {
  const unique = [...new Set(userIds)].filter(Boolean);
  const out = new Map<string, OrganizationOwnerResponse>();
  if (unique.length === 0) {
    return out;
  }

  try {
    const client = getClient();
    for (let i = 0; i < unique.length; i += INTERNAL_USERS_BY_IDS_MAX) {
      const chunk = unique.slice(i, i + INTERNAL_USERS_BY_IDS_MAX);
      const { data } = await client.post<
        SuccessEnvelope<{ users?: Record<string, unknown>[] }>
      >("/internal/v1/users/by-ids", { ids: chunk });
      if (!data?.success || !Array.isArray(data.data?.users)) {
        throw new Error("Identity service did not return users");
      }
      for (const raw of data.data.users) {
        const row = raw as Record<string, unknown>;
        const id = pickString(row.id);
        if (!id) continue;
        out.set(id, {
          id,
          name: pickString(row.name) ?? "",
          avatar: pickNullableString(row.avatar),
          bio: pickNullableString(row.bio),
        });
      }
    }
  } catch (e) {
    console.error("[identity-user.client] fetchOrganizationOwnersByUserIds:", e);
  }
  return out;
}
