import { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { SosEntity } from "./sos.entity";

export class SosRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async create(data: Prisma.SosCreateInput): Promise<SosEntity> {
    return this.prisma.sos.create({ data });
  }

  async findById(id: number): Promise<SosEntity | null> {
    return this.prisma.sos.findFirst({ where: { id, deletedAt: null } });
  }

  async findMany(params: {
    campaignId?: string;
    status?: number;
    skip?: number;
    take?: number;
  }): Promise<{ rows: SosEntity[]; total: number }> {
    const where: Prisma.SosWhereInput = {
      deletedAt: null,
      ...(params.campaignId ? { campaignId: params.campaignId } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.sos.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: params.skip ?? 0,
        take: params.take ?? 20,
      }),
      this.prisma.sos.count({ where }),
    ]);

    return { rows, total };
  }

  async update(id: number, data: Prisma.SosUpdateInput): Promise<SosEntity> {
    return this.prisma.sos.update({ where: { id }, data });
  }

  /** Resolve all active SOS for a campaign (used when marking a campaign as done). */
  async resolveAllByCampaignId(
    campaignId: string,
    updatedBy: string,
    completedStatus: number,
  ): Promise<void> {
    await this.prisma.sos.updateMany({
      where: { campaignId, deletedAt: null, status: { not: completedStatus } },
      data: { status: completedStatus, updatedBy },
    });
  }

  /**
   * Find SOS near a geographic point using PostGIS, sorted by distance ascending.
   */
  async findNearby(params: {
    latitude: number;
    longitude: number;
    maxDistanceMetres: number;
    campaignId?: string;
    status?: number;
    skip: number;
    take: number;
  }): Promise<{ rows: (SosEntity & { distanceMetres: number })[]; total: number }> {
    const { latitude, longitude, maxDistanceMetres, skip, take } = params;
    const conditions: string[] = ["deleted_at IS NULL"];
    const queryParams: unknown[] = [longitude, latitude, maxDistanceMetres];
    let idx = 4;

    if (params.campaignId) {
      conditions.push(`campaign_id = $${idx}::uuid`);
      queryParams.push(params.campaignId);
      idx++;
    }
    if (params.status !== undefined) {
      conditions.push(`status = $${idx}`);
      queryParams.push(params.status);
      idx++;
    }

    const whereClause = conditions.join(" AND ");

    const rows = await this.prisma.$queryRawUnsafe<
      (SosEntity & { distanceMetres: number })[]
    >(
      `
      SELECT
        id,
        campaign_id      AS "campaignId",
        content,
        phone,
        address,
        detail_address   AS "detailAddress",
        latitude,
        longitude,
        status,
        created_by       AS "createdBy",
        updated_by       AS "updatedBy",
        created_at       AS "createdAt",
        updated_at       AS "updatedAt",
        deleted_at       AS "deletedAt",
        ST_Distance(
          ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) AS "distanceMetres"
      FROM sos
      WHERE ${whereClause}
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND ST_DWithin(
          ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3
        )
      ORDER BY "distanceMetres" ASC
      LIMIT ${take} OFFSET ${skip}
    `,
      ...queryParams,
    );

    const countResult = await this.prisma.$queryRawUnsafe<[{ count: bigint }]>(
      `
      SELECT COUNT(*) AS count
      FROM sos
      WHERE ${whereClause}
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND ST_DWithin(
          ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3
        )
    `,
      ...queryParams,
    );

    return { rows, total: Number(countResult[0].count) };
  }
}

export const sosRepository = new SosRepository();
