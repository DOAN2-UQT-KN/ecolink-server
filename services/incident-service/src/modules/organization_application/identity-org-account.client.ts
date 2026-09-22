import axios, { AxiosInstance } from "axios";
import {
  getHttpCircuit,
  HTTP_CIRCUIT_IDENTITY,
} from "../../resilience/http-circuit";

interface SuccessEnvelope<T> {
  success?: boolean;
  data?: T;
}

/** identity-service snake-cases its responses (`snakeCaseResponseBody`). */
interface ProvisionOrgAccountResponseBody {
  user_id?: string;
  activation_token?: string;
  /** True when the account already existed, i.e. this call was a retry. */
  already_provisioned?: boolean;
}

export interface ProvisionedOrgAccount {
  userId: string;
  /** Present on the first successful provisioning; absent on an idempotent replay. */
  activationToken: string | null;
  alreadyProvisioned: boolean;
}

function identityCircuit() {
  return getHttpCircuit(HTTP_CIRCUIT_IDENTITY);
}

function getClient(): AxiosInstance {
  const baseURL = process.env.IDENTITY_SERVICE_URL?.trim();
  const key = process.env.INTERNAL_IDENTITY_API_KEY?.trim();
  if (!baseURL || !key) {
    throw new Error(
      "IDENTITY_SERVICE_URL and INTERNAL_IDENTITY_API_KEY must be configured to provision organization accounts",
    );
  }
  return axios.create({
    baseURL: baseURL.replace(/\/$/, ""),
    timeout: 10_000,
    headers: { "x-internal-api-key": key },
  });
}

/**
 * Creates (or returns) the dedicated login for an organization.
 *
 * Idempotent on `applicationId`, not on the email: this call is retried by the outbox relay
 * whenever identity-service is unreachable, and a retry must hand back the same account
 * rather than create a second one.
 */
export async function provisionOrgAccount(params: {
  applicationId: string;
  organizationId: string;
  email: string;
  displayName: string;
}): Promise<ProvisionedOrgAccount> {
  return identityCircuit().run(async () => {
    const client = getClient();
    const { data } = await client.post<
      SuccessEnvelope<ProvisionOrgAccountResponseBody>
    >("/internal/v1/users/provision-org-account", params);

    const userId = data?.data?.user_id;
    if (!data?.success || !userId) {
      throw new Error(
        "Identity service rejected the organization account provisioning request",
      );
    }
    return {
      userId,
      activationToken: data.data?.activation_token ?? null,
      alreadyProvisioned: Boolean(data.data?.already_provisioned),
    };
  });
}
