import { Prisma, PrismaClient } from "@prisma/client";
import { ApplicationStatus, OPEN_APPLICATION_STATUSES } from "@da2/constants";
import prisma from "../../config/prisma.client";

const OPEN_STATUSES: string[] = [...OPEN_APPLICATION_STATUSES];

/**
 * Statuses an admin never sees: until every owner has confirmed, the application is not in
 * the review queue at all.
 */
export const HIDDEN_FROM_ADMIN_STATUSES: string[] = [
  ApplicationStatus.DRAFT,
  ApplicationStatus.AWAITING_OWNER_CONFIRMATION,
];

/** Statuses in which a candidacy still "counts" against the anti-spam cap. */
const IN_FLIGHT_STATUSES: string[] = [
  ApplicationStatus.AWAITING_OWNER_CONFIRMATION,
  ApplicationStatus.PENDING_REVIEW,
  ApplicationStatus.NEEDS_REVISION,
];

const ACTIVE_OWNERS_INCLUDE = {
  where: { removedAt: null },
  orderBy: { createdAt: "asc" as const },
};

export class OrganizationApplicationRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  /* ---------------------------------------------------------------- */
  /* Applications                                                      */
  /* ---------------------------------------------------------------- */

  create(data: Prisma.OrganizationApplicationCreateInput) {
    return this.prisma.organizationApplication.create({ data });
  }

  findById(id: string) {
    return this.prisma.organizationApplication.findFirst({
      where: { id, deletedAt: null },
    });
  }

  findByIdWithRelations(id: string) {
    return this.prisma.organizationApplication.findFirst({
      where: { id, deletedAt: null },
      include: {
        documents: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
        events: { orderBy: { createdAt: "asc" } },
        owners: ACTIVE_OWNERS_INCLUDE,
      },
    });
  }

  findByIdWithOwners(id: string, client: Prisma.TransactionClient = this.prisma) {
    return client.organizationApplication.findFirst({
      where: { id, deletedAt: null },
      include: { owners: ACTIVE_OWNERS_INCLUDE },
    });
  }

  /**
   * Row lock on one application. Every transition (confirm, decline, expire, withdraw,
   * submit, approve) takes it first, so two of them racing on the same application are
   * serialized and the loser re-reads the winner's state.
   */
  async lockForUpdate(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "organization_applications" WHERE id = ${id}::uuid FOR UPDATE`;
  }

  findByCode(code: string) {
    return this.prisma.organizationApplication.findFirst({
      where: { code, deletedAt: null },
    });
  }

  /** The row that occupies the "one open application per submitter email" slot, if any. */
  findOpenBySubmitterEmail(submitterEmail: string) {
    return this.prisma.organizationApplication.findFirst({
      where: {
        submitterEmail,
        status: { in: OPEN_STATUSES },
        deletedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * How many other in-flight applications list each email as an (unremoved) owner. Feeds the
   * anti-spam cap: nobody can flood a mailbox by naming it on a stack of junk applications.
   */
  async countOtherCandidacies(
    emails: string[],
    excludeApplicationId: string,
  ): Promise<Map<string, number>> {
    if (emails.length === 0) return new Map();
    const groups = await this.prisma.organizationApplicationOwner.groupBy({
      by: ["email"],
      where: {
        email: { in: emails },
        removedAt: null,
        applicationId: { not: excludeApplicationId },
        application: { status: { in: IN_FLIGHT_STATUSES }, deletedAt: null },
      },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.email, g._count._all]));
  }

  async findBlockedEmails(emails: string[]): Promise<Set<string>> {
    if (emails.length === 0) return new Set();
    const rows = await this.prisma.ownerInviteBlock.findMany({
      where: { email: { in: emails } },
      select: { email: true },
    });
    return new Set(rows.map((r) => r.email));
  }

  findCandidateByTokenHash(confirmTokenHash: string) {
    return this.prisma.organizationApplicationOwner.findUnique({
      where: { confirmTokenHash },
      include: {
        application: { include: { owners: ACTIVE_OWNERS_INCLUDE } },
      },
    });
  }

  /** Candidates whose link ran out while their application still waits on them. */
  findOverdueCandidates(now: Date, take = 200) {
    return this.prisma.organizationApplicationOwner.findMany({
      where: {
        status: "PENDING",
        removedAt: null,
        expiresAt: { lt: now },
        application: {
          status: ApplicationStatus.AWAITING_OWNER_CONFIRMATION,
          deletedAt: null,
        },
      },
      select: { applicationId: true },
      distinct: ["applicationId"],
      take,
    });
  }

  update(id: string, data: Prisma.OrganizationApplicationUpdateInput) {
    return this.prisma.organizationApplication.update({ where: { id }, data });
  }

  async search(params: {
    status?: string[];
    excludeStatus?: string[];
    orgType?: string[];
    lane?: string[];
    q?: string;
    skip: number;
    take: number;
  }) {
    const where: Prisma.OrganizationApplicationWhereInput = {
      deletedAt: null,
      status: {
        ...(params.status?.length ? { in: params.status } : {}),
        ...(params.excludeStatus?.length ? { notIn: params.excludeStatus } : {}),
      },
      ...(params.orgType?.length ? { orgType: { in: params.orgType } } : {}),
      ...(params.lane?.length ? { lane: { in: params.lane } } : {}),
      ...(params.q
        ? {
            OR: [
              { code: { contains: params.q, mode: "insensitive" } },
              { submitterEmail: { contains: params.q, mode: "insensitive" } },
              { contactEmail: { contains: params.q, mode: "insensitive" } },
              {
                owners: {
                  some: {
                    removedAt: null,
                    OR: [
                      { fullName: { contains: params.q, mode: "insensitive" } },
                      { email: { contains: params.q, mode: "insensitive" } },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.organizationApplication.findMany({
        where,
        orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
        skip: params.skip,
        take: params.take,
        include: {
          documents: {
            where: { deletedAt: null },
            orderBy: { createdAt: "asc" },
          },
          owners: ACTIVE_OWNERS_INCLUDE,
        },
      }),
      this.prisma.organizationApplication.count({ where }),
    ]);

    return { rows, total };
  }

  /* ---------------------------------------------------------------- */
  /* Documents                                                         */
  /* ---------------------------------------------------------------- */

  createDocument(data: {
    submissionEmail: string;
    docType: string;
    storageKey: string;
    format: string;
    mimeType: string;
    sizeBytes: number;
    fileName?: string | null;
  }) {
    return this.prisma.organizationApplicationDocument.create({
      data: {
        submissionEmail: data.submissionEmail,
        docType: data.docType,
        storageKey: data.storageKey,
        format: data.format,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        fileName: data.fileName ?? null,
      },
    });
  }

  findDocumentById(id: string) {
    return this.prisma.organizationApplicationDocument.findFirst({
      where: { id, deletedAt: null },
    });
  }

  findDocumentsByIds(ids: string[]) {
    return this.prisma.organizationApplicationDocument.findMany({
      where: { id: { in: ids }, deletedAt: null },
    });
  }

  countDocumentsForApplication(applicationId: string) {
    return this.prisma.organizationApplicationDocument.count({
      where: { applicationId, deletedAt: null },
    });
  }

  /** Files uploaded under one verified mailbox that are not attached to anything yet. */
  countUnattachedDocuments(submissionEmail: string) {
    return this.prisma.organizationApplicationDocument.count({
      where: { submissionEmail, applicationId: null, deletedAt: null },
    });
  }

  attachDocuments(applicationId: string, documentIds: string[]) {
    return this.prisma.organizationApplicationDocument.updateMany({
      where: { id: { in: documentIds } },
      data: { applicationId },
    });
  }

  softDeleteDocument(id: string) {
    return this.prisma.organizationApplicationDocument.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                            */
  /* ---------------------------------------------------------------- */

  recordEvent(data: {
    applicationId: string;
    eventType: string;
    actorId?: string | null;
    payload?: Prisma.InputJsonValue;
    tx?: Prisma.TransactionClient;
  }) {
    const client = data.tx ?? this.prisma;
    return client.organizationApplicationEvent.create({
      data: {
        applicationId: data.applicationId,
        eventType: data.eventType,
        actorId: data.actorId ?? null,
        payload: data.payload ?? {},
      },
    });
  }

  /** Most recent event of one type, e.g. to rate-limit a notice. */
  findLatestEvent(applicationId: string, eventType: string) {
    return this.prisma.organizationApplicationEvent.findFirst({
      where: { applicationId, eventType },
      orderBy: { createdAt: "desc" },
    });
  }

  findEvents(applicationId: string) {
    return this.prisma.organizationApplicationEvent.findMany({
      where: { applicationId },
      orderBy: { createdAt: "asc" },
    });
  }
}

export const organizationApplicationRepository =
  new OrganizationApplicationRepository();
