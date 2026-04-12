import { PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";

export class OrganizationRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async create(data: {
    name: string;
    description?: string | null;
    logoUrl: string;
    backgroundUrl?: string | null;
    contactEmail?: string | null;
    ownerId: string;
    createdBy?: string;
  }) {
    return this.prisma.organization.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        logoUrl: data.logoUrl,
        backgroundUrl: data.backgroundUrl ?? null,
        contactEmail: data.contactEmail ?? null,
        ownerId: data.ownerId,
        createdBy: data.createdBy ?? data.ownerId,
      },
    });
  }

  async update(
    id: string,
    data: {
      name?: string;
      description?: string | null;
      logoUrl?: string;
      backgroundUrl?: string | null;
      contactEmail?: string | null;
      status?: number;
      isEmailVerified?: boolean;
      updatedBy?: string | null;
    },
  ) {
    return this.prisma.organization.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.logoUrl !== undefined && { logoUrl: data.logoUrl }),
        ...(data.backgroundUrl !== undefined && {
          backgroundUrl: data.backgroundUrl,
        }),
        ...(data.contactEmail !== undefined && {
          contactEmail: data.contactEmail,
        }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.isEmailVerified !== undefined && {
          isEmailVerified: data.isEmailVerified,
        }),
        ...(data.updatedBy !== undefined && { updatedBy: data.updatedBy }),
      },
    });
  }

  async findById(id: string) {
    return this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async findManyPaginated(
    filters: { search?: string },
    options: {
      skip: number;
      take: number;
      sortBy: "createdAt" | "updatedAt" | "name";
      sortOrder: "asc" | "desc";
    },
  ) {
    const where = {
      deletedAt: null as null,
      ...(filters.search
        ? {
            name: {
              contains: filters.search,
              mode: "insensitive" as const,
            },
          }
        : {}),
    };
    const orderBy =
      options.sortBy === "name"
        ? { name: options.sortOrder }
        : options.sortBy === "updatedAt"
          ? { updatedAt: options.sortOrder }
          : { createdAt: options.sortOrder };

    const [rows, total] = await Promise.all([
      this.prisma.organization.findMany({
        where,
        orderBy,
        skip: options.skip,
        take: options.take,
      }),
      this.prisma.organization.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * Organizations the user owns or is an approved member of (owner is not stored in `members`).
   */
  async findLinkedToUserPaginated(
    userId: string,
    filters: { search?: string; status?: number },
    options: {
      skip: number;
      take: number;
      sortBy: "createdAt" | "updatedAt" | "name";
      sortOrder: "asc" | "desc";
    },
  ) {
    const where = {
      deletedAt: null as null,
      OR: [
        { ownerId: userId },
        {
          members: {
            some: {
              userId,
              deletedAt: null,
            },
          },
        },
      ],
      ...(filters.search
        ? {
            name: {
              contains: filters.search,
              mode: "insensitive" as const,
            },
          }
        : {}),
      ...(filters.status !== undefined ? { status: filters.status } : {}),
    };
    const orderBy =
      options.sortBy === "name"
        ? { name: options.sortOrder }
        : options.sortBy === "updatedAt"
          ? { updatedAt: options.sortOrder }
          : { createdAt: options.sortOrder };

    const [rows, total] = await Promise.all([
      this.prisma.organization.findMany({
        where,
        orderBy,
        skip: options.skip,
        take: options.take,
      }),
      this.prisma.organization.count({ where }),
    ]);
    return { rows, total };
  }
}

export const organizationRepository = new OrganizationRepository();
