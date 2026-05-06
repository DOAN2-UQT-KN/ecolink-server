export interface OrganizationOwnerResponse {
  id: string;
  name: string;
  avatar: string | null;
  bio: string | null;
  organizationIds?: string[];
}

function getClientHeaders() {
  const baseURL = process.env.IDENTITY_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_IDENTITY_API_KEY?.trim();
  if (!baseURL || !key) {
    throw new Error(
      "IDENTITY_SERVICE_URL and INTERNAL_IDENTITY_API_KEY must be configured to load users",
    );
  }
  return { baseURL: baseURL.replace(/\/$/, ""), key };
}


function pickString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function pickNullableString(v: unknown): string | null {
  if (v === null) return null;
  const s = pickString(v);
  return s !== undefined ? s : null;
}

function readOrganizationIds(raw: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) {
      out.add(v.trim());
    }
  };

  add(raw.organizationId);
  add(raw.organization_id);

  const maybeArr = raw.organizationIds;
  if (Array.isArray(maybeArr)) {
    for (const v of maybeArr) {
      add(v);
    }
  }

  const maybeOrgRows = raw.organizations;
  if (Array.isArray(maybeOrgRows)) {
    for (const row of maybeOrgRows) {
      if (!row || typeof row !== "object") continue;
      const obj = row as Record<string, unknown>;
      add(obj.id);
      add(obj.organizationId);
      add(obj.organization_id);
    }
  }

  return [...out];
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
  const organizationIds = readOrganizationIds(row);
  return {
    id,
    name,
    avatar,
    bio,
    ...(organizationIds.length > 0 ? { organizationIds } : {}),
  };
}

const INTERNAL_USERS_BY_IDS_MAX = 100;

export async function fetchUsersByIds(
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
    const { baseURL, key } = getClientHeaders();
    for (let i = 0; i < unique.length; i += INTERNAL_USERS_BY_IDS_MAX) {
      const chunk = unique.slice(i, i + INTERNAL_USERS_BY_IDS_MAX);
      const res = await fetch(`${baseURL}/internal/v1/users/by-ids`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-api-key": key,
        },
        body: JSON.stringify({ ids: chunk }),
      });
      if (!res.ok) {
         throw new Error(`HTTP error! status: ${res.status}`);
      }
      const data = await res.json();
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
    console.error("[identity-user.client] fetchUsersByIds:", e);
  }
  return out;
}
