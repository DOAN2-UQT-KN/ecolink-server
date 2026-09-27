import { PrismaClient } from "@prisma/client";
import { OWNER_ROLES, OrgMemberRole } from "@da2/constants";
import prisma from "../../config/prisma.client";

const OWNER_ROLE_VALUES: string[] = [...OWNER_ROLES];

export class OrganizationMemberRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  /**
   * Adds (or revives) a plain member. A revived row is reset to `MEMBER`: rejoining after
   * leaving never brings back a role the person held before.
   */
  async addMember(organizationId: string, userId: string) {
    return this.prisma.organizationMember.upsert({
      where: {
        organizationId_userId: { organizationId, userId },
      },
      create: {
        organizationId,
        userId,
        role: OrgMemberRole.MEMBER,
        createdBy: userId,
      },
      update: {
        deletedAt: null,
        role: OrgMemberRole.MEMBER,
        updatedAt: new Date(),
      },
    });
  }

  /** The caller's active role in one organization, or null when not a member. */
  async findActiveRole(
    organizationId: string,
    userId: string,
  ): Promise<string | null> {
    const row = await this.prisma.organizationMember.findFirst({
      where: { organizationId, userId, deletedAt: null },
      select: { role: true },
    });
    return row?.role ?? null;
  }

  async isOwner(organizationId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.organizationMember.findFirst({
      where: {
        organizationId,
        userId,
        deletedAt: null,
        role: { in: OWNER_ROLE_VALUES },
      },
      select: { userId: true },
    });
    return !!row;
  }

  /** Active owners of each organization, keyed by organization id. */
  async findOwnersByOrganizationIds(
    organizationIds: string[],
  ): Promise<Map<string, { userId: string; role: string }[]>> {
    const out = new Map<string, { userId: string; role: string }[]>();
    if (organizationIds.length === 0) return out;
    const rows = await this.prisma.organizationMember.findMany({
      where: {
        organizationId: { in: organizationIds },
        deletedAt: null,
        role: { in: OWNER_ROLE_VALUES },
      },
      select: { organizationId: true, userId: true, role: true },
      orderBy: { createdAt: "asc" },
    });
    for (const row of rows) {
      const list = out.get(row.organizationId) ?? [];
      list.push({ userId: row.userId, role: row.role });
      out.set(row.organizationId, list);
    }
    return out;
  }

  async findOwnerUserIds(organizationId: string): Promise<string[]> {
    const owners = await this.findOwnersByOrganizationIds([organizationId]);
    return (owners.get(organizationId) ?? []).map((o) => o.userId);
  }

  /** Roles the user holds in each of the given organizations. */
  async findActiveRolesForUser(
    userId: string,
    organizationIds: string[],
  ): Promise<Map<string, string>> {
    if (organizationIds.length === 0) return new Map();
    const rows = await this.prisma.organizationMember.findMany({
      where: {
        userId,
        deletedAt: null,
        organizationId: { in: organizationIds },
      },
      select: { organizationId: true, role: true },
    });
    return new Map(rows.map((r) => [r.organizationId, r.role]));
  }

  /** How many organizations each user is currently an owner of (users with 0 are omitted). */
  async countActiveOwnerOrgs(userIds: string[]): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const groups = await this.prisma.organizationMember.groupBy({
      by: ["userId"],
      where: {
        userId: { in: userIds },
        deletedAt: null,
        role: { in: OWNER_ROLE_VALUES },
        organization: { deletedAt: null },
      },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.userId, g._count._all]));
  }

  async isActiveMember(organizationId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.organizationMember.findFirst({
      where: { organizationId, userId, deletedAt: null },
    });
    return !!row;
  }

  async findActiveMembershipOrgIds(
    userId: string,
    organizationIds: string[],
  ): Promise<Set<string>> {
    if (organizationIds.length === 0) return new Set();
    const rows = await this.prisma.organizationMember.findMany({
      where: {
        userId,
        deletedAt: null,
        organizationId: { in: organizationIds },
      },
      select: { organizationId: true },
    });
    return new Set(rows.map((r) => r.organizationId));
  }

  /** Active member counts per org; orgs with zero members are omitted. */
  async countActiveByOrganizationIds(
    organizationIds: string[],
  ): Promise<Map<string, number>> {
    if (organizationIds.length === 0) {
      return new Map();
    }
    const groups = await this.prisma.organizationMember.groupBy({
      by: ["organizationId"],
      where: {
        organizationId: { in: organizationIds },
        deletedAt: null,
      },
      _count: { _all: true },
    });
    const out = new Map<string, number>();
    for (const g of groups) {
      out.set(g.organizationId, g._count._all);
    }
    return out;
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

  /** All active memberships for an org (for in-memory name filter + pagination). */
  async findAllActiveByOrganization(organizationId: string) {
    return this.prisma.organizationMember.findMany({
      where: { organizationId, deletedAt: null },
      select: {
        organizationId: true,
        userId: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /** Soft-delete active membership; returns whether a row was updated. */
  async softDeleteMembership(
    organizationId: string,
    userId: string,
    actorId: string = userId,
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
        updatedBy: actorId,
      },
    });
    return result.count > 0;
  }
}

export const organizationMemberRepository = new OrganizationMemberRepository();
