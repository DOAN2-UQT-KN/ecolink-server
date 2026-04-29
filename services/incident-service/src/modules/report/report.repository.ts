import { PrismaClient, Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { ReportEntity } from "./report.entity";
import { ReportSearchWithScope } from "./report.dto";
import { GlobalStatus, ReportStatus } from "../../constants/status.enum";

/** Report row including non-deleted media links (for list/search responses). */
export type ReportWithMediaFiles = Prisma.ReportGetPayload<{
  include: {
    reportMediaFiles: { where: { deletedAt: null } };
  };
}>;

export class ReportRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async create(data: Prisma.ReportCreateInput): Promise<ReportEntity> {
    return this.prisma.report.create({ data });
  }

  async findById(id: string): Promise<ReportEntity | null> {
    return this.prisma.report.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async findByIdWithRelations(id: string) {
    return this.prisma.report.findFirst({
      where: { id, deletedAt: null },
      include: {
        reportMediaFiles: {
          where: { deletedAt: null },
        },
        campaign: {
          include: {
            campaignManagers: {
              where: { deletedAt: null },
            },
          },
        },
      },
    });
  }

  async findManyByIdsWithRelations(ids: string[]) {
    if (ids.length === 0) {
      return [];
    }
    return this.prisma.report.findMany({
      where: { id: { in: ids }, deletedAt: null },
      include: {
        reportMediaFiles: {
          where: { deletedAt: null },
        },
        campaign: {
          include: {
            campaignManagers: {
              where: { deletedAt: null },
            },
          },
        },
      },
    });
  }

  async update(
    id: string,
    data: Prisma.ReportUpdateInput,
  ): Promise<ReportEntity> {
    return this.prisma.report.update({
      where: { id },
      data,
    });
  }

  async softDelete(id: string): Promise<ReportEntity> {
    return this.prisma.report.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async findAll(): Promise<ReportEntity[]> {
    return this.prisma.report.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }

  /** All non-deleted reports with lifecycle status `GlobalStatus._STATUS_ACTIVE` (no pagination). */
  async findAllToDo(): Promise<ReportWithMediaFiles[]> {
    return this.prisma.report.findMany({
      where: {
        deletedAt: null,
        status: GlobalStatus._STATUS_TODO,
      },
      orderBy: { createdAt: "desc" },
      include: {
        reportMediaFiles: {
          where: { deletedAt: null },
        },
      },
    });
  }

  async markReportAsDone(id: string): Promise<ReportEntity> {
    return this.prisma.report.update({
      where: { id },
      data: {
        status: ReportStatus._STATUS_COMPLETED,
      },
    });
  }

  async search(
    query: ReportSearchWithScope,
  ): Promise<{ reports: ReportWithMediaFiles[]; total: number }> {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    const where: Prisma.ReportWhereInput = {
      deletedAt: null,
    };

    if (query.scopedUserId) {
      where.userId = query.scopedUserId;
    }

    // Search filter
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: "insensitive" } },
        { description: { contains: query.search, mode: "insensitive" } },
      ];
    }

    // Status filter
    if (query.status) {
      where.status = query.status;
    }

    // Waste type filter
    if (query.wasteType) {
      where.wasteType = query.wasteType;
    }

    // Severity level filter
    if (query.severityLevel !== undefined) {
      where.severityLevel = query.severityLevel;
    }

    // Build orderBy
    let orderBy: Prisma.ReportOrderByWithRelationInput = { createdAt: "desc" };
    if (query.sortBy === "severityLevel") {
      orderBy = { severityLevel: query.sortOrder || "desc" };
    } else if (query.sortBy === "createdAt") {
      orderBy = { createdAt: query.sortOrder || "desc" };
    }
    // Note: Distance sorting requires raw query with PostGIS

    const [reports, total] = await Promise.all([
      this.prisma.report.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: {
          reportMediaFiles: {
            where: { deletedAt: null },
          },
        },
      }),
      this.prisma.report.count({ where }),
    ]);

    return { reports, total };
  }

  /**
   * Search reports with distance calculation using raw SQL (PostGIS)
   * This is more complex but enables true geospatial queries
   */
  async searchWithDistance(
    userLat: number,
    userLng: number,
    query: ReportSearchWithScope,
  ): Promise<{
    reports: (ReportWithMediaFiles & { distance: number })[];
    total: number;
  }> {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const offset = (page - 1) * limit;
    const maxDistance = query.maxDistance || 50000; // Default 50km

    // Build WHERE conditions
    const conditions: string[] = ["deleted_at IS NULL"];
    const params: any[] = [userLng, userLat, maxDistance];
    let paramIndex = 4;

    if (query.search) {
      conditions.push(
        `(title ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`,
      );
      params.push(`%${query.search}%`);
      paramIndex++;
    }

    if (query.status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(query.status);
      paramIndex++;
    }

    if (query.wasteType) {
      conditions.push(`waste_type = $${paramIndex}`);
      params.push(query.wasteType);
      paramIndex++;
    }

    if (query.severityLevel !== undefined) {
      conditions.push(`severity_level = $${paramIndex}`);
      params.push(query.severityLevel);
      paramIndex++;
    }

    if (query.scopedUserId) {
      conditions.push(`user_id = $${paramIndex}`);
      params.push(query.scopedUserId);
      paramIndex++;
    }

    const whereClause = conditions.join(" AND ");
    const sortOrder = query.sortOrder === "asc" ? "ASC" : "DESC";

    let orderByClause = "distance ASC";
    if (query.sortBy === "severityLevel") {
      orderByClause = `severity_level ${sortOrder}`;
    } else if (query.sortBy === "createdAt") {
      orderByClause = `created_at ${sortOrder}`;
    }

    // Query with distance calculation
    const reports = await this.prisma.$queryRawUnsafe<
      (ReportEntity & { distance: number })[]
    >(
      `
            SELECT 
                id,
                user_id as "userId",
                title,
                description,
                waste_type as "wasteType",
                severity_level as "severityLevel",
                latitude,
                longitude,
                detail_address as "detailAddress",
                status,
                is_verify as "isVerify",
                ai_verified as "aiVerified",
                ai_recommendation as "aiRecommendation",
                created_at as "createdAt",
                updated_at as "updatedAt",
                deleted_at as "deletedAt",
                ST_Distance(
                    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
                    ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
                ) as distance
            FROM reports
            WHERE ${whereClause}
                AND latitude IS NOT NULL 
                AND longitude IS NOT NULL
                AND ST_DWithin(
                    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
                    ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                    $3
                )
            ORDER BY ${orderByClause}
            LIMIT ${limit} OFFSET ${offset}
        `,
      ...params,
    );

    // Count query
    const countResult = await this.prisma.$queryRawUnsafe<[{ count: bigint }]>(
      `
            SELECT COUNT(*) as count
            FROM reports
            WHERE ${whereClause}
                AND latitude IS NOT NULL 
                AND longitude IS NOT NULL
                AND ST_DWithin(
                    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
                    ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                    $3
                )
        `,
      ...params,
    );

    const total = Number(countResult[0].count);
    if (reports.length === 0) {
      return { reports: [], total };
    }

    const withMedia = await this.prisma.report.findMany({
      where: { id: { in: reports.map((r) => r.id) } },
      include: {
        reportMediaFiles: {
          where: { deletedAt: null },
        },
      },
    });
    const byId = new Map(withMedia.map((r) => [r.id, r]));
    const reportsWithMedia = reports.map((r) => {
      const full = byId.get(r.id);
      if (!full) {
        throw new Error(`Report ${r.id} missing after distance search`);
      }
      return { ...full, distance: r.distance };
    });

    return {
      reports: reportsWithMedia,
      total,
    };
  }
}

// Singleton instance
export const reportRepository = new ReportRepository();
