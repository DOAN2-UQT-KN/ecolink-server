import { PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { GlobalStatus } from "../../constants/status.enum";

export class OrganizationRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async create(data: {
    name: string;
    slug: string;
    description?: string | null;
    descriptionVi?: string | null;
    descriptionEn?: string | null;
    logoUrl: string;
    backgroundUrl?: string | null;
    contactEmail?: string | null;
    ownerId: string;
    createdBy?: string;
  }) {
    return this.prisma.organization.create({
      data: {
        name: data.name,
        slug: data.slug,
        description: data.description ?? null,
        descriptionVi: data.descriptionVi ?? null,
        descriptionEn: data.descriptionEn ?? null,
        logoUrl: data.logoUrl,
        backgroundUrl: data.backgroundUrl ?? null,
        contactEmail: data.contactEmail ?? null,
        // `organizations` only holds approved rows now, so there is no PENDING state to
        // start from; matches the column default.
        status: GlobalStatus._STATUS_ACTIVE,
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
      descriptionVi?: string | null;
      descriptionEn?: string | null;
      logoUrl?: string;
      backgroundUrl?: string | null;
      contactEmail?: string | null;
      status?: number;
      isEmailVerified?: boolean;
      slug?: string;
      rejectReason?: string | null;
      updatedBy?: string | null;
    },
  ) {
    return this.prisma.organization.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && {
          description: data.description,
        }),
        ...(data.descriptionVi !== undefined && {
          descriptionVi: data.descriptionVi,
        }),
        ...(data.descriptionEn !== undefined && {
          descriptionEn: data.descriptionEn,
        }),
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
        ...(data.slug !== undefined && { slug: data.slug }),
        ...(data.rejectReason !== undefined && {
          rejectReason: data.rejectReason,
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

  async findBySlug(slug: string) {
    return this.prisma.organization.findFirst({
      where: { slug, deletedAt: null },
    });
  }

  /**
   * Slugs that would collide with `base` or `base-{n}` (includes soft-deleted rows
   * so a deleted org keeps its public URL reserved).
   */
  async findSlugsConflictingWithBase(base: string): Promise<string[]> {
    const rows = await this.prisma.organization.findMany({
      where: {
        OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }],
      },
      select: { slug: true },
    });
    return rows.map((r) => r.slug);
  }

  /** Active org with the same name + contact email (name match is case-insensitive). */
  async findActiveByNameAndContactEmail(
    name: string,
    contactEmail: string,
    excludeId?: string,
  ) {
    const trimmedName = name.trim();
    const normalizedEmail = contactEmail.trim().toLowerCase();
    if (!trimmedName || !normalizedEmail) {
      return null;
    }
    return this.prisma.organization.findFirst({
      where: {
        deletedAt: null,
        contactEmail: normalizedEmail,
        name: { equals: trimmedName, mode: "insensitive" },
        status: { not: GlobalStatus._STATUS_INACTIVE },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
  }

  async findManyByIds(ids: string[]) {
    if (ids.length === 0) {
      return [];
    }
    return this.prisma.organization.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
        backgroundUrl: true,
        contactEmail: true,
        ownerId: true,
      },
    });
  }

  async findManyPaginated(
    filters: {
      search?: string;
      status?: number[];
      isEmailVerified?: boolean;
      /** Intersect with this id set (e.g. join-request status filter for the current user). */
      organizationIdIn?: string[];
    },
    options: {
      skip: number;
      take: number;
      sortBy: "createdAt" | "updatedAt" | "name";
      sortOrder: "asc" | "desc";
    },
  ) {
    if (
      filters.organizationIdIn !== undefined &&
      filters.organizationIdIn.length === 0
    ) {
      return { rows: [], total: 0 };
    }
    const where = {
      deletedAt: null as null,
      ...(filters.organizationIdIn !== undefined
        ? { id: { in: filters.organizationIdIn } }
        : {}),
      ...(filters.search
        ? {
            name: {
              contains: filters.search,
              mode: "insensitive" as const,
            },
          }
        : {}),
      ...(filters.status !== undefined && filters.status.length > 0
        ? { status: { in: filters.status } }
        : {}),
      ...(filters.isEmailVerified !== undefined
        ? { isEmailVerified: filters.isEmailVerified }
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
    filters: {
      search?: string;
      status?: number[];
      isEmailVerified?: boolean;
      organizationIdIn?: string[];
      /** Narrow to owned only (`true`) or member-but-not-owner (`false`). */
      isOwner?: boolean;
    },
    options: {
      skip: number;
      take: number;
      sortBy: "createdAt" | "updatedAt" | "name";
      sortOrder: "asc" | "desc";
    },
  ) {
    if (
      filters.organizationIdIn !== undefined &&
      filters.organizationIdIn.length === 0
    ) {
      return { rows: [], total: 0 };
    }
    const linkScope =
      filters.isOwner === true
        ? { ownerId: userId }
        : filters.isOwner === false
          ? {
              ownerId: { not: userId },
              members: {
                some: {
                  userId,
                  deletedAt: null,
                },
              },
            }
          : {
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
            };
    const where = {
      deletedAt: null as null,
      ...(filters.organizationIdIn !== undefined
        ? { id: { in: filters.organizationIdIn } }
        : {}),
      ...linkScope,
      ...(filters.search
        ? {
            name: {
              contains: filters.search,
              mode: "insensitive" as const,
            },
          }
        : {}),
      ...(filters.status !== undefined && filters.status.length > 0
        ? { status: { in: filters.status } }
        : {}),
      ...(filters.isEmailVerified !== undefined
        ? { isEmailVerified: filters.isEmailVerified }
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
}

export const organizationRepository = new OrganizationRepository();
