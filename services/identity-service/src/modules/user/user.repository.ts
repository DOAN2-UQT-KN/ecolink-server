import { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";
import type {
  AdminListUsersQuery,
  AdminListUsersSortBy,
} from "./user.dto";
import { UserEntity, UserWithRole } from "./user.entity";

const SORT_FIELD_MAP: Record<AdminListUsersSortBy, keyof UserEntity> = {
  created_at: "createdAt",
  name: "name",
  email: "email",
};

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

  /**
   * Active people whose email or name contains `q` (case-insensitive), for the organization
   * member / owner pickers. Deleted and banned accounts are left out.
   */
  async searchActive(q: string, limit: number): Promise<UserEntity[]> {
    const term = q.trim();
    if (term.length < 2) return [];
    return this.prisma.user.findMany({
      where: {
        deletedAt: null,
        status: 1,
        OR: [
          { email: { contains: term, mode: "insensitive" } },
          { name: { contains: term, mode: "insensitive" } },
        ],
      },
      orderBy: { name: "asc" },
      take: Math.min(Math.max(limit, 1), 20),
    });
  }

  /** Case-insensitive lookup of several emails at once. */
  async findManyByEmails(emails: string[]): Promise<UserEntity[]> {
    const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()))].filter(
      Boolean,
    );
    if (unique.length === 0) {
      return [];
    }
    return this.prisma.user.findMany({
      where: {
        deletedAt: null,
        OR: unique.map((email) => ({
          email: { equals: email, mode: "insensitive" as const },
        })),
      },
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
    phoneNumber: string | null;
    gender: string | null;
    dateOfBirth: Date | null;
    emailVerified: boolean;
    createdAt: Date;
    updatedAt: Date;
    latitude: number | null;
    longitude: number | null;
    locationUpdatedAt: Date | null;
    detailAddress: string | null;
    notificationPreferences: unknown;
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
        phoneNumber: true,
        gender: true,
        dateOfBirth: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
        latitude: true,
        longitude: true,
        locationUpdatedAt: true,
        detailAddress: true,
        notificationPreferences: true,
      },
    });
  }

  async findNotificationPrefsByIds(
    ids: string[],
  ): Promise<{ id: string; notificationPreferences: unknown }[]> {
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) {
      return [];
    }
    return this.prisma.user.findMany({
      where: { id: { in: unique }, deletedAt: null },
      select: { id: true, notificationPreferences: true },
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

  /**
   * All active users with distance (meters) from the point; null distance if no stored location.
   * Parameters: longitude, latitude (degrees).
   */
  async findActiveUsersWithDistanceFromPoint(
    longitude: number,
    latitude: number,
  ): Promise<
    {
      id: string;
      email: string;
      name: string;
      latitude: number | null;
      longitude: number | null;
      distanceMeters: number | null;
    }[]
  > {
    const rows = await this.prisma.$queryRawUnsafe<
      {
        id: string;
        email: string;
        name: string;
        latitude: number | null;
        longitude: number | null;
        distanceMeters: number | null;
      }[]
    >(
      `
            SELECT u.id,
                   u.email,
                   u.name,
                   u."latitude",
                   u."longitude",
                   CASE
                     WHEN u."latitude" IS NULL OR u."longitude" IS NULL THEN NULL
                     ELSE round((6371000 * acos(LEAST(1.0, GREATEST(-1.0,
                       cos(radians($2)) * cos(radians(u."latitude")) * cos(radians(u."longitude") - radians($1))
                       + sin(radians($2)) * sin(radians(u."latitude"))
                     ))))::numeric, 0)
                   END AS "distanceMeters"
            FROM users u
            WHERE u."deletedAt" IS NULL
            ORDER BY "distanceMeters" ASC NULLS LAST, u.email ASC
        `,
      longitude,
      latitude,
    );
    return rows;
  }

  async update(
    id: string,
    data: Prisma.UserUpdateInput,
  ): Promise<UserEntity> {
    return this.prisma.user.update({
      where: { id },
      data,
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

  async findManyForAdmin(
    query: AdminListUsersQuery,
  ): Promise<{ users: UserWithRole[]; total: number }> {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
    };

    if (query.status !== undefined) {
      where.status = query.status;
    }

    const search = query.search?.trim();
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    const orderField = SORT_FIELD_MAP[query.sortBy] ?? "createdAt";
    const skip = (query.page - 1) * query.limit;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: { role: { select: { name: true } } },
        orderBy: { [orderField]: query.sortOrder },
        skip,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { users, total };
  }
}

// Singleton instance
export const userRepository = new UserRepository();
