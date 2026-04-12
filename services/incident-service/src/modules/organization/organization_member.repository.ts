import { PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";

export class OrganizationMemberRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async addMember(organizationId: string, userId: string) {
    return this.prisma.organizationMember.upsert({
      where: {
        organizationId_userId: { organizationId, userId },
      },
      create: {
        organizationId,
        userId,
        createdBy: userId,
      },
      update: {
        deletedAt: null,
        updatedAt: new Date(),
      },
    });
  }

  async isActiveMember(organizationId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.organizationMember.findFirst({
      where: { organizationId, userId, deletedAt: null },
    });
    return !!row;
  }

  async findByOrganizationPaginated(
    organizationId: string,
    filters: { userId?: string },
    options: {
      skip: number;
      take: number;
      sortBy: "createdAt" | "updatedAt";
      sortOrder: "asc" | "desc";
    },
  ) {
    const where = {
      organizationId,
      deletedAt: null as null,
      ...(filters.userId ? { userId: filters.userId } : {}),
    };
    const orderBy =
      options.sortBy === "updatedAt"
        ? { updatedAt: options.sortOrder }
        : { createdAt: options.sortOrder };

    const [rows, total] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where,
        orderBy,
        skip: options.skip,
        take: options.take,
      }),
      this.prisma.organizationMember.count({ where }),
    ]);
    return { rows, total };
  }

  /** Soft-delete active membership; returns whether a row was updated. */
  async softDeleteMembership(
    organizationId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await this.prisma.organizationMember.updateMany({
      where: {
        organizationId,
        userId,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: userId,
      },
    });
    return result.count > 0;
  }
}

export const organizationMemberRepository = new OrganizationMemberRepository();
