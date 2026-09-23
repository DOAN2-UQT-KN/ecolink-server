import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { rateLimitDisabled } from "../../middleware/rate-limit.middleware";
import {
  digestsMatch,
  generateNumericOtp,
  generateOpaqueToken,
  hashOpaqueToken,
} from "../../utils/token-hash";
import { enqueueApplicationOtpEmail } from "./organization-application-notify.client";
import {
  OtpPurpose,
  organizationApplicationOtpRepository,
} from "./organization-application-otp.repository";
import { buildApplicationResumeUrl } from "./organization-application-urls";

const OTP_TTL_MS = Number(process.env.APPLICATION_OTP_TTL_MS ?? 10 * 60 * 1000);
const SUBMISSION_TOKEN_TTL_MS = Number(
  process.env.APPLICATION_SUBMISSION_TOKEN_TTL_MS ?? 30 * 60 * 1000,
);
/** After this many wrong guesses the code is burned and a new one must be requested. */
const MAX_OTP_ATTEMPTS = Number(process.env.APPLICATION_OTP_MAX_ATTEMPTS ?? 5);
/**
 * Second line of defence behind the express-rate-limit middleware: that one lives in the
 * API process's memory, so it resets on deploy and is per-instance. This one is in the DB.
 */
const MAX_OTP_PER_EMAIL_PER_HOUR = Number(
  process.env.OTP_RATE_MAX_PER_EMAIL ?? 3,
);
/** The tracking link has to survive a slow review, so it lives far longer than the rest. */
const TRACKING_TOKEN_TTL_MS = Number(
  process.env.APPLICATION_TRACKING_TOKEN_TTL_MS ?? 180 * 24 * 60 * 60 * 1000,
);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class OrganizationApplicationOtpService {
  /**
   * Issues a fresh code and mails it.
   *
   * A failed send leaves **nothing** behind: the new row is deleted and previously issued
   * codes are left alone. Otherwise a mail outage would spend the applicant's three codes an
   * hour on codes they never received, locking them out of the form for an hour — which is
   * exactly the moment they most need it to work.
   */
  async requestOtp(
    rawEmail: string,
  ): Promise<{ sentAt: Date; expiresAt: Date }> {
    const email = normalizeEmail(rawEmail);

    // Two counters guard this endpoint — the middleware's in-memory one and this DB one.
    // The dev escape hatch has to lift both, otherwise it only half works.
    if (!rateLimitDisabled()) {
      const issuedLastHour =
        await organizationApplicationOtpRepository.countIssuedSince(
          email,
          new Date(Date.now() - 60 * 60 * 1000),
        );
      if (issuedLastHour >= MAX_OTP_PER_EMAIL_PER_HOUR) {
        throw new HttpError(
          HTTP_STATUS.TOO_MANY_REQUESTS.withMessage(
            "Too many verification codes requested for this email, try again later",
          ),
        );
      }
    }

    const otp = generateNumericOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    const issued = await organizationApplicationOtpRepository.create({
      email,
      purpose: OtpPurpose.OTP,
      codeHash: hashOpaqueToken(otp),
      expiresAt,
    });
    const linkToken = generateOpaqueToken();
    const link = await organizationApplicationOtpRepository.create({
      email,
      purpose: OtpPurpose.LINK,
      codeHash: hashOpaqueToken(linkToken),
      expiresAt,
    });

    try {
      await enqueueApplicationOtpEmail({
        toEmail: email,
        otp,
        expiresInMinutes: Math.round(OTP_TTL_MS / 60000),
        applyUrl: buildApplicationResumeUrl(linkToken),
      });
    } catch (error) {
      // Telling the caller "sent" when it was not would leave them waiting for a mail that
      // never arrives, so this failure is surfaced — but only after undoing the write.
      await Promise.all(
        [issued.id, link.id].map((id) =>
          organizationApplicationOtpRepository.deleteById(id),
        ),
      ).catch((cleanupError) => {
        console.error(
          "[organization-application] failed to roll back an unsent OTP:",
          cleanupError,
        );
      });
      console.error("[organization-application] failed to send OTP:", error);
      throw new HttpError(
        HTTP_STATUS.SERVICE_UNAVAILABLE.withMessage(
          "Could not send the verification code, please try again",
        ),
      );
    }

    // Only now that the new code is on its way do older ones stop working; expiring them up
    // front would kill a perfectly good code sitting in the inbox whenever a send fails.
    await organizationApplicationOtpRepository.expireActiveFor(
      email,
      OtpPurpose.OTP,
      issued.id,
    );
    await organizationApplicationOtpRepository.expireActiveFor(
      email,
      OtpPurpose.LINK,
      link.id,
    );

    return { sentAt: issued.createdAt, expiresAt };
  }

  /**
   * Resolves the link mailed with the code back to its address, so a closed tab does not
   * cost the applicant a fresh code. Never consumes it and grants nothing on its own — the
   * code still has to be typed.
   */
  async resolveEmailLink(
    token: string,
  ): Promise<{ email: string; sentAt: Date; expiresAt: Date }> {
    const record = await organizationApplicationOtpRepository.findActiveByHash(
      hashOpaqueToken(token.trim()),
      OtpPurpose.LINK,
    );
    if (!record) {
      throw new HttpError(
        HTTP_STATUS.OTP_INVALID.withMessage(
          "This link is invalid or has expired, please request a new code",
        ),
      );
    }
    return {
      email: record.email,
      sentAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Checks the code and, on success, hands back a single-use submission token. The token is
   * what later proves "this browser owns that mailbox" without any login.
   */
  async verifyOtp(
    rawEmail: string,
    otp: string,
  ): Promise<{ submissionToken: string; expiresAt: Date }> {
    const email = normalizeEmail(rawEmail);
    const record = await organizationApplicationOtpRepository.findActive(
      email,
      OtpPurpose.OTP,
    );
    if (!record) {
      throw new HttpError(HTTP_STATUS.OTP_INVALID);
    }

    if (record.attempts >= MAX_OTP_ATTEMPTS) {
      await organizationApplicationOtpRepository.markUsed(record.id);
      throw new HttpError(HTTP_STATUS.OTP_TOO_MANY_ATTEMPTS);
    }

    if (!digestsMatch(record.codeHash, hashOpaqueToken(otp.trim()))) {
      await organizationApplicationOtpRepository.incrementAttempts(record.id);
      throw new HttpError(HTTP_STATUS.OTP_INVALID);
    }

    await organizationApplicationOtpRepository.markUsed(record.id);
    await organizationApplicationOtpRepository.expireActiveFor(
      email,
      OtpPurpose.LINK,
    );
    await organizationApplicationOtpRepository.expireActiveFor(
      email,
      OtpPurpose.SUBMISSION,
    );

    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + SUBMISSION_TOKEN_TTL_MS);
    await organizationApplicationOtpRepository.create({
      email,
      purpose: OtpPurpose.SUBMISSION,
      codeHash: hashOpaqueToken(token),
      expiresAt,
    });

    return { submissionToken: token, expiresAt };
  }

  /**
   * Resolves a token to the verified address without consuming it — the form calls the
   * presign endpoint several times before it finally submits.
   */
  async resolveSubmissionToken(token: string): Promise<string> {
    const record = await organizationApplicationOtpRepository.findActiveByHash(
      hashOpaqueToken(token.trim()),
      OtpPurpose.SUBMISSION,
    );
    if (!record) {
      throw new HttpError(HTTP_STATUS.SUBMISSION_TOKEN_INVALID);
    }
    return record.email;
  }

  /**
   * Long-lived token embedded in the tracking link. Reusable on purpose: the applicant opens
   * it whenever they want to see where the review stands, or to resubmit after a request for
   * more information.
   */
  async issueTrackingToken(
    rawEmail: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const email = normalizeEmail(rawEmail);
    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + TRACKING_TOKEN_TTL_MS);
    await organizationApplicationOtpRepository.create({
      email,
      purpose: OtpPurpose.TRACKING,
      codeHash: hashOpaqueToken(token),
      expiresAt,
    });
    return { token, expiresAt };
  }

  /** Resolves a tracking token to the mailbox it was issued for; never consumes it. */
  async resolveTrackingToken(token: string): Promise<string> {
    const record = await organizationApplicationOtpRepository.findActiveByHash(
      hashOpaqueToken(token.trim()),
      OtpPurpose.TRACKING,
    );
    if (!record) {
      throw new HttpError(HTTP_STATUS.SUBMISSION_TOKEN_INVALID);
    }
    return record.email;
  }

  /** Burns the token; called once the application row has been written. */
  async consumeSubmissionToken(token: string): Promise<string> {
    const record = await organizationApplicationOtpRepository.findActiveByHash(
      hashOpaqueToken(token.trim()),
      OtpPurpose.SUBMISSION,
    );
    if (!record) {
      throw new HttpError(HTTP_STATUS.SUBMISSION_TOKEN_INVALID);
    }
    await organizationApplicationOtpRepository.markUsed(record.id);
    return record.email;
  }
}

export const organizationApplicationOtpService =
  new OrganizationApplicationOtpService();
