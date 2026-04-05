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
}

export const savedResourceRepository = new SavedResourceRepository();
