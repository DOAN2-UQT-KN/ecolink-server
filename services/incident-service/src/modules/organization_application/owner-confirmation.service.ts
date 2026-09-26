import {
  ApplicationEventType,
  ApplicationStatus,
  OwnerCandidateStatus,
} from "@da2/constants";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { hashOpaqueToken } from "../../utils/token-hash";
import {
  ApplicationProfileInput,
  ConfirmationRequestMeta,
  OwnerConfirmationSummaryResponse,
} from "./organization-application.dto";
import { organizationApplicationRepository } from "./organization-application.repository";
import { organizationApplicationOtpService } from "./organization-application-otp.service";
import {
  enqueueOwnerConfirmationExpiredEmail,
  enqueueOwnerDeclinedEmail,
} from "./organization-application-notify.client";
import { buildApplicationTrackUrl } from "./organization-application-urls";
import { normalizeEmail } from "./owner-candidates";

/** Application states in which a candidate may still answer. */
const ANSWERABLE_STATUSES: string[] = [
  ApplicationStatus.AWAITING_OWNER_CONFIRMATION,
  // The submitter may be fixing another owner's row; confirmations keep arriving meanwhile.
  ApplicationStatus.NEEDS_REVISION,
];

type Profile = Partial<ApplicationProfileInput>;

/**
 * The public side of owner confirmation. There is no login: owning the mailbox the link was
 * sent to is the proof of consent, as in any invitation flow. The IP and user agent of the
 * click are kept as evidence.
 */
export class OwnerConfirmationService {
  async getSummary(
    rawToken: string,
    sessionEmail?: string | null,
  ): Promise<OwnerConfirmationSummaryResponse> {
    const candidate = await this.findByToken(rawToken);
    const application = candidate.application;
    const profile = (application.profile ?? {}) as Profile;
    const now = new Date();

    return {
      status: candidate.status,
      applicationStatus: application.status,
      active: ANSWERABLE_STATUSES.includes(application.status),
      expired:
        candidate.status === OwnerCandidateStatus.EXPIRED ||
        (candidate.status === OwnerCandidateStatus.PENDING &&
          !!candidate.expiresAt &&
          candidate.expiresAt < now),
      expiresAt: candidate.expiresAt,
      applicationCode: application.code,
      organization: {
        name: profile.name ?? null,
        orgType: application.orgType,
        address: profile.address ?? null,
        logoUrl: profile.logoUrl ?? null,
        description: profile.description ?? null,
      },
      submitterEmail: application.submitterEmail,
      candidate: {
        email: candidate.email,
        fullName: candidate.fullName,
        isLegalRep: candidate.isLegalRep,
      },
      otherOwners: application.owners
        .filter((o) => o.id !== candidate.id)
        .map((o) => ({ email: o.email, fullName: o.fullName, isLegalRep: o.isLegalRep })),
      // A signed-in user opening someone else's link gets a clear warning instead of
      // silently confirming on that person's behalf.
      sessionEmailMismatch:
        !!sessionEmail && normalizeEmail(sessionEmail) !== candidate.email,
    };
  }

  /**
   * Records the confirmation. When it is the last one, the application moves to
   * PENDING_REVIEW inside the same transaction — no job sweeps for it later.
   */
  async confirm(
    rawToken: string,
    meta: ConfirmationRequestMeta,
  ): Promise<{ alreadyDone: boolean; remaining: number; applicationStatus: string }> {
    const found = await this.findByToken(rawToken);

    return prisma.$transaction(async (tx) => {
      await organizationApplicationRepository.lockForUpdate(tx, found.applicationId);
      const candidate = await tx.organizationApplicationOwner.findUniqueOrThrow({
        where: { id: found.id },
        include: { application: true },
      });
      const application = candidate.application;
      const now = new Date();

      if (candidate.removedAt) {
        throw new HttpError(HTTP_STATUS.OWNER_CONFIRMATION_NOT_FOUND);
      }
      if (candidate.status === OwnerCandidateStatus.CONFIRMED) {
        return { alreadyDone: true, remaining: 0, applicationStatus: application.status };
      }
      if (candidate.status === OwnerCandidateStatus.DECLINED) {
        throw new HttpError(HTTP_STATUS.ALREADY_DECLINED);
      }
      // Checked before expiry so a withdrawn application says so, instead of "expired".
      if (!ANSWERABLE_STATUSES.includes(application.status)) {
        throw new HttpError(HTTP_STATUS.APPLICATION_NOT_ACTIVE);
      }
      if (
        candidate.status === OwnerCandidateStatus.EXPIRED ||
        !candidate.expiresAt ||
        candidate.expiresAt < now
      ) {
        throw new HttpError(HTTP_STATUS.CONFIRM_EXPIRED);
      }

      await tx.organizationApplicationOwner.update({
        where: { id: candidate.id },
        data: {
          status: OwnerCandidateStatus.CONFIRMED,
          respondedAt: now,
          confirmIp: meta.ip,
          confirmUa: meta.userAgent?.slice(0, 512) ?? null,
        },
      });
      await organizationApplicationRepository.recordEvent({
        tx,
        applicationId: application.id,
        eventType: ApplicationEventType.OWNER_CONFIRMED,
        payload: {
          candidateId: candidate.id,
          email: candidate.email,
          changes: { status: { before: candidate.status, after: "CONFIRMED" } },
        },
      });

      const remaining = await tx.organizationApplicationOwner.count({
        where: {
          applicationId: application.id,
          removedAt: null,
          status: { not: OwnerCandidateStatus.CONFIRMED },
        },
      });

      let applicationStatus = application.status;
      if (
        remaining === 0 &&
        application.status === ApplicationStatus.AWAITING_OWNER_CONFIRMATION
      ) {
        applicationStatus = ApplicationStatus.PENDING_REVIEW;
        await tx.organizationApplication.update({
          where: { id: application.id },
          data: { status: applicationStatus, submittedAt: now },
        });
        await organizationApplicationRepository.recordEvent({
          tx,
          applicationId: application.id,
          eventType: ApplicationEventType.READY_FOR_REVIEW,
        });
      }

      return { alreadyDone: false, remaining, applicationStatus };
    });
  }

  /**
   * "I'm not involved." As important as the confirm button: an exit for someone listed by
   * mistake, and a fraud signal. Sends the application back to the submitter.
   */
  async decline(
    rawToken: string,
    input: { reason?: string | null; blockFuture?: boolean },
  ): Promise<{ applicationStatus: string }> {
    const found = await this.findByToken(rawToken);
    const reason = input.reason?.trim().slice(0, 1000) || null;

    const result = await prisma.$transaction(async (tx) => {
      await organizationApplicationRepository.lockForUpdate(tx, found.applicationId);
      const candidate = await tx.organizationApplicationOwner.findUniqueOrThrow({
        where: { id: found.id },
        include: { application: true },
      });
      const application = candidate.application;
      const now = new Date();

      if (candidate.removedAt) {
        throw new HttpError(HTTP_STATUS.OWNER_CONFIRMATION_NOT_FOUND);
      }
      if (candidate.status === OwnerCandidateStatus.DECLINED) {
        return { applicationStatus: application.status, notify: false, application, candidate };
      }
      if (candidate.status === OwnerCandidateStatus.CONFIRMED) {
        throw new HttpError(HTTP_STATUS.ALREADY_CONFIRMED);
      }
      if (!ANSWERABLE_STATUSES.includes(application.status)) {
        throw new HttpError(HTTP_STATUS.APPLICATION_NOT_ACTIVE);
      }

      await tx.organizationApplicationOwner.update({
        where: { id: candidate.id },
        data: {
          status: OwnerCandidateStatus.DECLINED,
          respondedAt: now,
          declineReason: reason,
        },
      });
      await tx.organizationApplication.update({
        where: { id: application.id },
        data: {
          status: ApplicationStatus.NEEDS_REVISION,
          reviewNote: `Owner ${candidate.email} không xác nhận.`,
        },
      });
      if (input.blockFuture) {
        await tx.ownerInviteBlock.upsert({
          where: { email: candidate.email },
          create: { email: candidate.email, sourceCandidateId: candidate.id },
          update: {},
        });
      }
      await organizationApplicationRepository.recordEvent({
        tx,
        applicationId: application.id,
        eventType: ApplicationEventType.OWNER_DECLINED,
        payload: {
          candidateId: candidate.id,
          email: candidate.email,
          reason,
          blockedFutureInvites: Boolean(input.blockFuture),
        },
      });

      return {
        applicationStatus: ApplicationStatus.NEEDS_REVISION as string,
        notify: true,
        application,
        candidate,
      };
    });

    if (result.notify) {
      const profile = (result.application.profile ?? {}) as Profile;
      const tracking = await organizationApplicationOtpService.issueTrackingToken(
        result.application.submitterEmail,
      );
      void enqueueOwnerDeclinedEmail({
        toEmail: result.application.submitterEmail,
        organizationName: profile.name ?? result.application.code,
        ownerEmail: result.candidate.email,
        reason: reason ?? "",
        trackUrl: buildApplicationTrackUrl(result.application.id, tracking.token),
      }).catch((err) => {
        console.warn("[owner-confirmation] failed to send the decline email", err);
      });
    }

    return { applicationStatus: result.applicationStatus };
  }

  /**
   * Hourly sweep: candidates whose 14 days ran out send their application back to the
   * submitter. Each application is handled in its own locked transaction, so a confirmation
   * arriving at the same moment either wins cleanly or sees the expiry.
   */
  async expireOverdue(now = new Date()): Promise<number> {
    const due = await organizationApplicationRepository.findOverdueCandidates(now);
    let expiredApplications = 0;

    for (const { applicationId } of due) {
      const outcome = await prisma.$transaction(async (tx) => {
        await organizationApplicationRepository.lockForUpdate(tx, applicationId);
        const application = await organizationApplicationRepository.findByIdWithOwners(
          applicationId,
          tx,
        );
        if (
          !application ||
          application.status !== ApplicationStatus.AWAITING_OWNER_CONFIRMATION
        ) {
          return null;
        }
        const overdue = application.owners.filter(
          (o) =>
            o.status === OwnerCandidateStatus.PENDING &&
            o.expiresAt &&
            o.expiresAt < now,
        );
        if (overdue.length === 0) return null;

        await tx.organizationApplicationOwner.updateMany({
          where: { id: { in: overdue.map((o) => o.id) } },
          // The hash is kept so the old link still explains itself ("expired").
          data: { status: OwnerCandidateStatus.EXPIRED },
        });
        const emails = overdue.map((o) => o.email);
        await tx.organizationApplication.update({
          where: { id: application.id },
          data: {
            status: ApplicationStatus.NEEDS_REVISION,
            reviewNote: `Owner ${emails.join(", ")} không xác nhận kịp hạn.`,
          },
        });
        await organizationApplicationRepository.recordEvent({
          tx,
          applicationId: application.id,
          eventType: ApplicationEventType.OWNER_EXPIRED,
          payload: { candidateIds: overdue.map((o) => o.id), emails },
        });
        return { application, emails };
      });

      if (!outcome) continue;
      expiredApplications += 1;
      const profile = (outcome.application.profile ?? {}) as Profile;
      try {
        const tracking = await organizationApplicationOtpService.issueTrackingToken(
          outcome.application.submitterEmail,
        );
        await enqueueOwnerConfirmationExpiredEmail({
          toEmail: outcome.application.submitterEmail,
          organizationName: profile.name ?? outcome.application.code,
          ownerEmails: outcome.emails.join(", "),
          trackUrl: buildApplicationTrackUrl(outcome.application.id, tracking.token),
        });
      } catch (err) {
        console.warn("[owner-confirmation] failed to send the expiry email", err);
      }
    }

    return expiredApplications;
  }

  private async findByToken(rawToken: string) {
    const token = rawToken?.trim();
    if (!token) throw new HttpError(HTTP_STATUS.OWNER_CONFIRMATION_NOT_FOUND);
    const candidate =
      await organizationApplicationRepository.findCandidateByTokenHash(
        hashOpaqueToken(token),
      );
    if (!candidate || candidate.removedAt) {
      throw new HttpError(HTTP_STATUS.OWNER_CONFIRMATION_NOT_FOUND);
    }
    return candidate;
  }
}

export const ownerConfirmationService = new OwnerConfirmationService();
