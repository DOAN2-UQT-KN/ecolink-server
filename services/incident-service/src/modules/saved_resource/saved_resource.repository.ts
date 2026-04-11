import { PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";

export class SavedResourceRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  findByUserAndResource(
    userId: string,
    resourceType: string,
    resourceId: string,
  ) {
    return this.prisma.savedResource.findUnique({
      where: {
        userId_resourceType_resourceId: {
          userId,
          resourceType,
          resourceId,
        },
      },
    });
  }

  create(userId: string, resourceType: string, resourceId: string) {
    return this.prisma.savedResource.create({
      data: { userId, resourceType, resourceId },
    });
  }

  restore(id: string) {
    return this.prisma.savedResource.update({
      where: { id },
      data: { deletedAt: null },
    });
  }

  softDelete(id: string) {
    return this.prisma.savedResource.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /** Resource IDs the user has actively saved (not soft-deleted), for batch embedding on report/campaign payloads. */
  findActiveSavedResourceIdsForUser(
    userId: string,
    resourceType: string,
    resourceIds: string[],
  ): Promise<Set<string>> {
    const unique = [...new Set(resourceIds)];
    if (unique.length === 0) {
      return Promise.resolve(new Set());
    }
    return this.prisma.savedResource
      .findMany({
        where: {
          userId,
          resourceType,
          resourceId: { in: unique },
          deletedAt: null,
        },
        select: { resourceId: true },
      })
      .then((rows) => new Set(rows.map((r) => r.resourceId)));
  }

  findManyPaginatedForUser(params: {
    userId: string;
    resourceType?: string;
    skip: number;
    take: number;
    sortBy: "createdAt" | "updatedAt";
    sortOrder: "asc" | "desc";
  }) {
    const where: {
      userId: string;
      deletedAt: null;
      resourceType?: string;
    } = {
      userId: params.userId,
      deletedAt: null,
      ...(params.resourceType ? { resourceType: params.resourceType } : {}),
    };
    return Promise.all([
      this.prisma.savedResource.findMany({
        where,
        orderBy: { [params.sortBy]: params.sortOrder },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.savedResource.count({ where }),
    ]).then(([rows, total]) => ({ rows, total }));
  }
}

export const savedResourceRepository = new SavedResourceRepository();
