import { PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";

/** What a row in `organization_application_otps` is for. */
export const OtpPurpose = {
  /** 6-digit code mailed to the address the applicant claims to own. */
  OTP: "OTP",
  /** Opaque token handed out once the code was accepted; unlocks the submit endpoints. */
  SUBMISSION: "SUBMISSION",
  /**
   * Long-lived token in the tracking link. Unlike the other two it is not single-use — the
   * applicant follows the same link repeatedly while the review runs.
   */
  TRACKING: "TRACKING",
  /**
   * Opaque token in the "continue your application" link mailed alongside the code. It only
   * reveals which address the code went to, so the form can reopen with the email locked;
   * the code itself still has to be typed. Lives exactly as long as the code it travels with.
   */
  LINK: "LINK",
} as const;

export type OtpPurposeValue = (typeof OtpPurpose)[keyof typeof OtpPurpose];

export class OrganizationApplicationOtpRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async create(data: {
    email: string;
    purpose: OtpPurposeValue;
    codeHash: string;
    expiresAt: Date;
  }) {
    return this.prisma.organizationApplicationOtp.create({
      data: {
        email: data.email,
        purpose: data.purpose,
        codeHash: data.codeHash,
        expiresAt: data.expiresAt,
      },
    });
  }

  /**
   * Burns every still-usable row of a purpose for one address, so an older mail in the inbox
   * stops working. `excludeId` spares the code we just issued.
   */
  async expireActiveFor(
    email: string,
    purpose: OtpPurposeValue,
    excludeId?: string,
  ) {
    return this.prisma.organizationApplicationOtp.updateMany({
      where: {
        email,
        purpose,
        usedAt: null,
        expiresAt: { gt: new Date() },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      data: { expiresAt: new Date() },
    });
  }

  /**
   * Removes a row outright. Used when a code was written but never reached the applicant —
   * leaving it behind would consume their hourly budget for a code they never received.
   */
  async deleteById(id: string) {
    return this.prisma.organizationApplicationOtp.delete({ where: { id } });
  }

  /** Most recent unused, unexpired row — the only one a code is checked against. */
  async findActive(email: string, purpose: OtpPurposeValue) {
    return this.prisma.organizationApplicationOtp.findFirst({
      where: { email, purpose, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
  }

  async findActiveByHash(codeHash: string, purpose: OtpPurposeValue) {
    return this.prisma.organizationApplicationOtp.findFirst({
      where: { codeHash, purpose, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
  }

  async incrementAttempts(id: string) {
    return this.prisma.organizationApplicationOtp.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }

  async markUsed(id: string) {
    return this.prisma.organizationApplicationOtp.update({
      where: { id },
      data: { usedAt: new Date() },
    });
  }

  /** Counts codes issued for one address inside a window (second line after the IP limiter). */
  async countIssuedSince(email: string, since: Date) {
    return this.prisma.organizationApplicationOtp.count({
      where: { email, purpose: OtpPurpose.OTP, createdAt: { gte: since } },
    });
  }
}

export const organizationApplicationOtpRepository =
  new OrganizationApplicationOtpRepository();
