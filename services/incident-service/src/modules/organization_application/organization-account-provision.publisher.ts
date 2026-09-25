import { ApplicationEventType } from "@da2/constants";
import prisma from "../../config/prisma.client";
import type {
  OutboxEventMessage,
  OutboxPublisher,
} from "../../outbox/outbox-publisher";
import { provisionOrgAccount } from "./identity-org-account.client";
import { enqueueOrgAccountActivationEmail } from "./organization-application-notify.client";
import { buildOrgAccountActivationUrl } from "./organization-application-urls";

/** Payload written by the approval transaction. */
export interface OrgAccountProvisionPayload {
  applicationId: string;
  organizationId: string;
  email: string;
  displayName: string;
  /** CC'd on the activation mail when the applicant gave one. */
  legalRepEmail?: string | null;
}

const ACTIVATION_TTL_HOURS = 72;

function parsePayload(raw: unknown): OrgAccountProvisionPayload {
  const payload = (raw ?? {}) as Partial<OrgAccountProvisionPayload>;
  if (
    !payload.applicationId ||
    !payload.organizationId ||
    !payload.email ||
    !payload.displayName
  ) {
    throw new Error("ORG_ACCOUNT_PROVISION payload is incomplete");
  }
  return payload as OrgAccountProvisionPayload;
}

/**
 * Second half of the approval saga, driven by the outbox relay.
 *
 * Step 1 (organization row + channels + application status) already committed. This step
 * creates the ORG login in identity-service, attaches it as owner, and mails the activation
 * link. Throwing here is safe and expected: the relay keeps the event PENDING and retries
 * with backoff, and because identity's endpoint is idempotent on `applicationId`, a retry
 * cannot produce a duplicate account. The organization is never rolled back — an
 * organization briefly without a login is recoverable, a lost approval is not.
 */
export class OrganizationAccountProvisionPublisher implements OutboxPublisher {
  async publish(event: OutboxEventMessage): Promise<void> {
    const payload = parsePayload(event.payload);

    const account = await provisionOrgAccount({
      applicationId: payload.applicationId,
      organizationId: payload.organizationId,
      email: payload.email,
      displayName: payload.displayName,
    });

    await prisma.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id: payload.organizationId },
        data: { ownerId: account.userId, updatedBy: account.userId },
      });
      // The owner is also recorded as a member with role OWNER so member listings and
      // permission checks have a single source to read from.
      await tx.organizationMember.upsert({
        where: {
          organizationId_userId: {
            organizationId: payload.organizationId,
            userId: account.userId,
          },
        },
        create: {
          organizationId: payload.organizationId,
          userId: account.userId,
          createdBy: account.userId,
        },
        update: { deletedAt: null },
      });
      await tx.organizationApplication.update({
        where: { id: payload.applicationId },
        data: { accountProvisionedAt: new Date() },
      });
      await tx.organizationApplicationEvent.create({
        data: {
          applicationId: payload.applicationId,
          eventType: ApplicationEventType.ACCOUNT_PROVISIONED,
          payload: {
            userId: account.userId,
            alreadyProvisioned: account.alreadyProvisioned,
          },
        },
      });
    });

    // A replay has no fresh token: the first attempt already mailed one, and the
    // organization can always ask for a new link.
    if (!account.activationToken) {
      return;
    }

    await enqueueOrgAccountActivationEmail({
      toEmail: payload.email,
      organizationName: payload.displayName,
      activationUrl: buildOrgAccountActivationUrl(account.activationToken),
      expiresInHours: ACTIVATION_TTL_HOURS,
    });
  }
}

export const organizationAccountProvisionPublisher =
  new OrganizationAccountProvisionPublisher();
