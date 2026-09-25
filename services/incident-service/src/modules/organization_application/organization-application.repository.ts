import { Prisma, PrismaClient } from "@prisma/client";
import { ApplicationStatus, OPEN_APPLICATION_STATUSES } from "@da2/constants";
import prisma from "../../config/prisma.client";

const OPEN_STATUSES: string[] = [...OPEN_APPLICATION_STATUSES];

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
      },
    });
  }

  findByCode(code: string) {
    return this.prisma.organizationApplication.findFirst({
      where: { code, deletedAt: null },
    });
  }

  /** The row that occupies the "one open application per contact email" slot, if any. */
  findOpenByContactEmail(contactEmail: string, excludeId?: string) {
    return this.prisma.organizationApplication.findFirst({
      where: {
        contactEmail,
        status: { in: OPEN_STATUSES },
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  }

  /**
   * Open applications standing in the name of one representative. Counted together with the
   * organizations they already own — otherwise someone could file ten submissions at once and
   * stay under the cap until they were all approved.
   */
  countOpenByLegalRepHash(legalRepIdHash: string, excludeId?: string) {
    return this.prisma.organizationApplication.count({
      where: {
        legalRepIdHash,
        status: { in: [...OPEN_STATUSES, ApplicationStatus.APPROVED] },
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  }

  /**
   * Highest per-organization override granted to this representative, if any. Admins raise
   * the cap on an organization; the raise then applies to the person behind it.
   */
  async findLegalRepLimitOverride(
    legalRepIdHash: string,
  ): Promise<number | null> {
    const rows = await this.prisma.organization.findMany({
      where: {
        deletedAt: null,
        legalRepLimitOverride: { not: null },
        application: { legalRepIdHash },
      },
      select: { legalRepLimitOverride: true },
    });
    const values = rows
      .map((r) => r.legalRepLimitOverride)
      .filter((v): v is number => typeof v === "number");
    return values.length ? Math.max(...values) : null;
  }

  update(id: string, data: Prisma.OrganizationApplicationUpdateInput) {
    return this.prisma.organizationApplication.update({ where: { id }, data });
  }

  async search(params: {
    status?: string[];
    orgType?: string[];
    lane?: string[];
    q?: string;
    skip: number;
    take: number;
  }) {
    const where: Prisma.OrganizationApplicationWhereInput = {
      deletedAt: null,
      ...(params.status?.length ? { status: { in: params.status } } : {}),
      ...(params.orgType?.length ? { orgType: { in: params.orgType } } : {}),
      ...(params.lane?.length ? { lane: { in: params.lane } } : {}),
      ...(params.q
        ? {
            OR: [
              { code: { contains: params.q, mode: "insensitive" } },
              { contactEmail: { contains: params.q, mode: "insensitive" } },
              { legalRepName: { contains: params.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.organizationApplication.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: params.skip,
        take: params.take,
        include: {
          documents: {
            where: { deletedAt: null },
            orderBy: { createdAt: "asc" },
          },
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

  findEvents(applicationId: string) {
    return this.prisma.organizationApplicationEvent.findMany({
      where: { applicationId },
      orderBy: { createdAt: "asc" },
    });
  }
}

export const organizationApplicationRepository =
  new OrganizationApplicationRepository();
