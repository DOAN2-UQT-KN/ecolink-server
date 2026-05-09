import { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { UserEntity } from "./user.entity";

export class UserRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async create(data: Prisma.UserCreateInput): Promise<UserEntity> {
    return this.prisma.user.create({ data });
  }

  async findById(id: string): Promise<UserEntity | null> {
    return this.prisma.user.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async findByIds(ids: string[]): Promise<UserEntity[]> {
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) {
      return [];
    }
    return this.prisma.user.findMany({
      where: { id: { in: unique }, deletedAt: null },
    });
  }

  async findEmailById(id: string): Promise<{ email: string } | null> {
    return this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { email: true },
    });
  }

  async findByEmail(email: string): Promise<UserEntity | null> {
    return this.prisma.user.findFirst({
      where: { email, deletedAt: null },
    });
  }

  async findCurrentUserById(id: string): Promise<{
    id: string;
    email: string;
    name: string;
    roleId: string;
    avatar: string | null;
    bio: string | null;
    emailVerified: boolean;
    createdAt: Date;
    updatedAt: Date;
    latitude: number | null;
    longitude: number | null;
    locationUpdatedAt: Date | null;
  } | null> {
    return this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        roleId: true,
        avatar: true,
        bio: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
        latitude: true,
        longitude: true,
        locationUpdatedAt: true,
      },
    });
  }

  /**
   * Active users with stored coordinates within `radiusMeters` of the point (Haversine, Earth radius 6371 km).
   * Parameters: longitude, latitude (degrees), radiusMeters.
   */
  async findActiveUserIdsNearPoint(
    longitude: number,
    latitude: number,
    radiusMeters: number,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `
            SELECT u.id
            FROM users u
            WHERE u."deletedAt" IS NULL
              AND u."latitude" IS NOT NULL
              AND u."longitude" IS NOT NULL
              AND (
                6371000 * acos(
                  LEAST(1.0, GREATEST(-1.0,
                    cos(radians($2)) * cos(radians(u."latitude")) * cos(radians(u."longitude") - radians($1))
                    + sin(radians($2)) * sin(radians(u."latitude"))
                  ))
                )
              ) <= $3
        `,
      longitude,
      latitude,
      radiusMeters,
    );
    return rows.map((r) => r.id).filter(Boolean);
  }

  async update(id: string, entity: Partial<UserEntity>): Promise<UserEntity> {
    return this.prisma.user.update({
      where: { id },
      data: entity,
    });
  }

  async softDelete(id: string): Promise<UserEntity> {
    return this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async findAll(): Promise<UserEntity[]> {
    return this.prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }
}

// Singleton instance
export const userRepository = new UserRepository();
