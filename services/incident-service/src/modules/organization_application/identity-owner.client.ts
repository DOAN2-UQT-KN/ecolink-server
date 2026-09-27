import axios, { AxiosInstance } from "axios";
import {
  getHttpCircuit,
  HTTP_CIRCUIT_IDENTITY,
} from "../../resilience/http-circuit";

interface SuccessEnvelope<T> {
  success?: boolean;
  data?: T;
}

/** identity-service `users.status`. */
export const IdentityUserStatus = {
  ACTIVE: 1,
  /** Banned / suspended. */
  INACTIVE: 2,
  /** Created for an approved owner; no password yet. */
  PENDING_ACTIVATION: 3,
} as const;

/** identity-service snake-cases its responses (`snakeCaseResponseBody`). */
interface IdentityUserBody {
  id: string;
  email: string;
  name: string;
  status: number;
  created_at: string;
  avatar?: string | null;
}

export interface IdentityUserSummary {
  id: string;
  email: string;
  name: string;
  status: number;
  createdAt: Date;
  avatar?: string | null;
}

function identityCircuit() {
  return getHttpCircuit(HTTP_CIRCUIT_IDENTITY);
}

function getClient(): AxiosInstance {
  const baseURL = process.env.IDENTITY_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_IDENTITY_API_KEY?.trim();
  if (!baseURL || !key) {
    throw new Error(
      "IDENTITY_SERVICE_URL and INTERNAL_IDENTITY_API_KEY must be configured to resolve organization owners",
    );
  }
  return axios.create({
    baseURL: baseURL.replace(/\/$/, ""),
    timeout: 10_000,
    headers: { "x-internal-api-key": key },
  });
}

function toSummary(body: IdentityUserBody): IdentityUserSummary {
  return {
    id: body.id,
    email: body.email.toLowerCase(),
    name: body.name,
    status: body.status,
    createdAt: new Date(body.created_at),
    avatar: body.avatar ?? null,
  };
}

function byEmail(users: IdentityUserSummary[]): Map<string, IdentityUserSummary> {
  return new Map(users.map((u) => [u.email, u]));
}

/** Existing accounts for these emails, keyed by lower-cased email. Missing emails have none. */
export async function lookupUsersByEmails(
  emails: string[],
): Promise<Map<string, IdentityUserSummary>> {
  if (emails.length === 0) return new Map();
  return identityCircuit().run(async () => {
    const { data } = await getClient().post<
      SuccessEnvelope<{ users?: IdentityUserBody[] }>
    >("/internal/v1/users/lookup-by-emails", { emails });
    if (!data?.success) {
      throw new Error("Identity service rejected the user lookup");
    }
    return byEmail((data.data?.users ?? []).map(toSummary));
  });
}

/**
 * Finds or creates one person account per email. New accounts are `PENDING_ACTIVATION` with
 * no password. Idempotent on the email, so a retried approval hands back the same users.
 */
export async function ensureUsers(
  users: { email: string; fullName: string }[],
): Promise<Map<string, IdentityUserSummary>> {
  if (users.length === 0) return new Map();
  return identityCircuit().run(async () => {
    const { data } = await getClient().post<
      SuccessEnvelope<{ users?: IdentityUserBody[] }>
    >("/internal/v1/users/ensure", { users });
    if (!data?.success) {
      throw new Error("Identity service rejected the ensure-users request");
    }
    return byEmail((data.data?.users ?? []).map(toSummary));
  });
}

/**
 * Issues a fresh 72-hour activation token for a `PENDING_ACTIVATION` user and revokes older
 * ones. Returns null when the user is already active (nothing to activate).
 */
export async function issueActivationToken(
  userId: string,
): Promise<{ token: string; expiresInHours: number } | null> {
  return identityCircuit().run(async () => {
    const { data } = await getClient().post<
      SuccessEnvelope<{
        activation_token?: string | null;
        expires_in_hours?: number;
      }>
    >(`/internal/v1/users/${encodeURIComponent(userId)}/activation-token`, {});
    if (!data?.success) {
      throw new Error("Identity service rejected the activation token request");
    }
    const token = data.data?.activation_token;
    if (!token) return null;
    return { token, expiresInHours: data.data?.expires_in_hours ?? 72 };
  });
}

/** Accounts by id (with email and status), keyed by id. */
export async function lookupUsersByIds(
  ids: string[],
): Promise<Map<string, IdentityUserSummary>> {
  if (ids.length === 0) return new Map();
  return identityCircuit().run(async () => {
    const { data } = await getClient().post<
      SuccessEnvelope<{ users?: IdentityUserBody[] }>
    >("/internal/v1/users/lookup-by-ids", { ids });
    if (!data?.success) {
      throw new Error("Identity service rejected the user lookup by id");
    }
    return new Map((data.data?.users ?? []).map((u) => [u.id, toSummary(u)]));
  });
}

/** Active people whose email or name contains `q`. Emails come back in full. */
export async function searchUsers(
  q: string,
  limit: number,
): Promise<IdentityUserSummary[]> {
  return identityCircuit().run(async () => {
    const { data } = await getClient().post<
      SuccessEnvelope<{ users?: IdentityUserBody[] }>
    >("/internal/v1/users/search", { q, limit });
    if (!data?.success) {
      throw new Error("Identity service rejected the user search");
    }
    return (data.data?.users ?? []).map(toSummary);
  });
}
