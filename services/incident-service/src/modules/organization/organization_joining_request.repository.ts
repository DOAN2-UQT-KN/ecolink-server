import { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { JoinRequestStatus } from "../../constants/status.enum";

export class OrganizationJoiningRequestRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async create(data: { organizationId: string; requesterId: string }) {
    return this.prisma.organizationJoiningRequest.create({
      data: {
        organizationId: data.organizationId,
        requesterId: data.requesterId,
        status: JoinRequestStatus._STATUS_PENDING,
        createdBy: data.requesterId,
      },
    });
  }

  async findById(id: string) {
    return this.prisma.organizationJoiningRequest.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async findByIdWithOrganization(id: string) {
    return this.prisma.organizationJoiningRequest.findFirst({
      where: { id, deletedAt: null },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            ownerId: true,
            deletedAt: true,
          },
        },
      },
    });
  }

  async findPending(organizationId: string, requesterId: string) {
    return this.prisma.organizationJoiningRequest.findFirst({
      where: {
        organizationId,
        requesterId,
        status: JoinRequestStatus._STATUS_PENDING,
        deletedAt: null,
      },
    });
  }

  /** Most recent join request for this org and user (e.g. for `request_status` on org detail). */
  async findLatestByOrganizationAndRequester(
    organizationId: string,
    requesterId: string,
  ) {
    return this.prisma.organizationJoiningRequest.findFirst({
      where: {
        organizationId,
        requesterId,
        deletedAt: null,
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  async findByOrganizationPaginated(
    organizationId: string,
    filters: { status?: number; requesterId?: string },
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
      ...(filters.status !== undefined ? { status: filters.status } : {}),
      ...(filters.requesterId ? { requesterId: filters.requesterId } : {}),
    };
    const orderBy =
      options.sortBy === "updatedAt"
        ? { updatedAt: options.sortOrder }
        : { createdAt: options.sortOrder };

    const [rows, total] = await Promise.all([
      this.prisma.organizationJoiningRequest.findMany({
        where,
        orderBy,
        skip: options.skip,
        take: options.take,
      }),
      this.prisma.organizationJoiningRequest.count({ where }),
    ]);
    return { rows, total };
  }

  async findByRequesterPaginated(
    requesterId: string,
    filters: { organizationId?: string; status?: number },
    options: {
      skip: number;
      take: number;
      sortBy: "createdAt" | "updatedAt";
      sortOrder: "asc" | "desc";
    },
  ) {
    const where = {
      requesterId,
      deletedAt: null as null,
      ...(filters.organizationId
        ? { organizationId: filters.organizationId }
        : {}),
      ...(filters.status !== undefined ? { status: filters.status } : {}),
    };
    const orderBy =
      options.sortBy === "updatedAt"
        ? { updatedAt: options.sortOrder }
        : { createdAt: options.sortOrder };
    const include = {
      organization: {
        select: {
          id: true,
          name: true,
          ownerId: true,
        },
      },
    };

    const [rows, total] = await Promise.all([
      this.prisma.organizationJoiningRequest.findMany({
        where,
        include,
        orderBy,
        skip: options.skip,
        take: options.take,
      }),
      this.prisma.organizationJoiningRequest.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * Latest join-request status per organization for this requester (by `updatedAt` desc).
   * Used to attach `request_status` on organization list responses without N+1 queries.
   */
  async findLatestStatusByOrganizationForRequester(
    requesterId: string,
    organizationIds: string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (organizationIds.length === 0) {
      return map;
    }
    const rows = await this.prisma.organizationJoiningRequest.findMany({
      where: {
        requesterId,
        organizationId: { in: organizationIds },
        deletedAt: null,
      },
      orderBy: { updatedAt: "desc" },
      select: { organizationId: true, status: true },
    });
    for (const row of rows) {
      if (!map.has(row.organizationId)) {
        map.set(row.organizationId, row.status);
      }
    }
    return map;
  }

  /**
   * Organization ids where the viewer's latest non-deleted join request has exactly `status`
   * (by `updated_at` per organization). Used to filter org list queries.
   */
  async findOrganizationIdsWhereLatestJoinRequestStatusEquals(
    requesterId: string,
    status: number,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ organization_id: string }[]>(
      Prisma.sql`
        SELECT organization_id FROM (
          SELECT DISTINCT ON (organization_id) organization_id, status
          FROM organization_joining_requests
          WHERE requester_id = ${requesterId}::uuid
            AND deleted_at IS NULL
          ORDER BY organization_id, updated_at DESC
        ) AS latest
        WHERE latest.status = ${status}
      `,
    );
    return rows.map((r) => r.organization_id);
  }

  async updateStatus(id: string, status: number) {
    return this.prisma.organizationJoiningRequest.update({
      where: { id },
      data: { status },
    });
  }

  async softDelete(id: string) {
    return this.prisma.organizationJoiningRequest.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}

export const organizationJoiningRequestRepository =
  new OrganizationJoiningRequestRepository();
