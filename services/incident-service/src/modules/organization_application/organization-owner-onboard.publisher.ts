import { ApplicationEventType } from "@da2/constants";
import type {
  OutboxEventMessage,
  OutboxPublisher,
} from "../../outbox/outbox-publisher";
import { issueActivationToken } from "./identity-owner.client";
import {
  enqueueAccountActivationEmail,
  enqueueOwnerAttachedEmail,
} from "./organization-application-notify.client";
import { organizationApplicationRepository } from "./organization-application.repository";
import {
  buildAccountActivationUrl,
  buildOrganizationManageUrl,
} from "./organization-application-urls";

/** Payload written by the approval transaction, one event per owner. */
export interface OrgOwnerOnboardPayload {
  applicationId: string;
  candidateId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  userId: string;
  email: string;
  fullName: string;
  isLegalRep: boolean;
}

function parsePayload(raw: unknown): OrgOwnerOnboardPayload {
  const payload = (raw ?? {}) as Partial<OrgOwnerOnboardPayload>;
  if (
    !payload.applicationId ||
    !payload.candidateId ||
    !payload.organizationId ||
    !payload.userId ||
    !payload.email
  ) {
    throw new Error("ORG_OWNER_ONBOARD payload is incomplete");
  }
  return payload as OrgOwnerOnboardPayload;
}

/**
 * Tells one approved owner about their new role. The membership already exists — this step
 * only picks the email:
 *
 *   - account still `PENDING_ACTIVATION` (created for this approval, or never activated):
 *     a fresh 72-hour activation link to set a first password
 *   - active account: "you were added as an owner of X", with a link to the organization.
 *     Never a password-reset link — that would look exactly like phishing.
 *
 * Throwing is safe: the relay retries with backoff. A retry mints a new activation token,
 * which revokes the previous one, so at most one link works at a time.
 */
export class OrganizationOwnerOnboardPublisher implements OutboxPublisher {
  async publish(event: OutboxEventMessage): Promise<void> {
    const payload = parsePayload(event.payload);

    const activation = await issueActivationToken(payload.userId);

    if (activation) {
      await enqueueAccountActivationEmail({
        toEmail: payload.email,
        fullName: payload.fullName,
        organizationName: payload.organizationName,
        activationUrl: buildAccountActivationUrl(activation.token),
        expiresInHours: activation.expiresInHours,
      });
    } else {
      await enqueueOwnerAttachedEmail({
        toEmail: payload.email,
        fullName: payload.fullName,
        organizationName: payload.organizationName,
        isLegalRep: payload.isLegalRep,
        manageUrl: buildOrganizationManageUrl(payload.organizationSlug),
      });
    }

    await organizationApplicationRepository.recordEvent({
      applicationId: payload.applicationId,
      eventType: ApplicationEventType.OWNER_ATTACHED,
      payload: {
        candidateId: payload.candidateId,
        userId: payload.userId,
        email: activation ? "ACCOUNT_ACTIVATION" : "ORG_OWNER_ATTACHED",
      },
    });
  }
}

export const organizationOwnerOnboardPublisher =
  new OrganizationOwnerOnboardPublisher();
