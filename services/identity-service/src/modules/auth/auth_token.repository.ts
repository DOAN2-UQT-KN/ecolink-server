import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { AuthTokenType } from "../../constants/auth-token-type";
import type { AuthTokenTypeValue } from "../../constants/auth-token-type";

const now = (): Date => new Date();

export class AuthTokenRepository {
  async create(data: {
    userId: string;
    type: AuthTokenTypeValue;
    tokenHash: string;
    expiresAt: Date;
    metadata?: Prisma.InputJsonValue;
  }) {
    return prisma.authToken.create({
      data: {
        userId: data.userId,
        type: data.type,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
        metadata: data.metadata,
      },
    });
  }

  async findActiveByHashAndType(tokenHash: string, type: AuthTokenTypeValue) {
    return prisma.authToken.findFirst({
      where: {
        tokenHash,
        type,
        revokedAt: null,
        usedAt: null,
        expiresAt: { gt: now() },
      },
    });
  }

  /** Tokens of one type issued to a user since `since` (DB-side rate limit). */
  async countCreatedSince(
    userId: string,
    type: AuthTokenTypeValue,
    since: Date,
  ): Promise<number> {
    return prisma.authToken.count({
      where: { userId, type, createdAt: { gte: since } },
    });
  }

  async revokeById(id: string): Promise<void> {
    await prisma.authToken.update({
      where: { id },
      data: { revokedAt: now() },
    });
  }

  async revokeAllForUser(userId: string, type: AuthTokenTypeValue): Promise<void> {
    await prisma.authToken.updateMany({
      where: {
        userId,
        type,
        revokedAt: null,
      },
      data: { revokedAt: now() },
    });
  }

  async markUsed(id: string): Promise<void> {
    await prisma.authToken.update({
      where: { id },
      data: { usedAt: now() },
    });
  }

  /** Revoke pending org contact-email tokens for one organization (before issuing a new link). */
  async revokeActiveOrganizationContactEmail(
    organizationId: string,
  ): Promise<void> {
    const t = now();
    await prisma.$executeRaw`
      UPDATE auth_tokens
      SET revoked_at = ${t}
      WHERE type = ${AuthTokenType.ORGANIZATION_CONTACT_EMAIL}
        AND revoked_at IS NULL
        AND used_at IS NULL
        AND expires_at > ${t}
        AND metadata->>'organizationId' = ${organizationId}
    `;
  }
}

export const authTokenRepository = new AuthTokenRepository();
