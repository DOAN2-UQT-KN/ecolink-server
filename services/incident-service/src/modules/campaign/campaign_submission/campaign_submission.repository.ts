import { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../../config/prisma.client";
import { ResultStatus } from "../../../constants/status.enum";

export class CampaignSubmissionRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async create(data: {
    campaignId: string;
    submittedBy: string;
    title?: string;
    description?: string;
  }) {
    return this.prisma.campaignSubmission.create({
      data: {
        campaignId: data.campaignId,
        submittedBy: data.submittedBy,
        title: data.title,
        description: data.description,
        status: ResultStatus._STATUS_INREVIEW,
        createdBy: data.submittedBy,
        updatedBy: data.submittedBy,
      },
    });
  }

  async findById(id: string) {
    return this.prisma.campaignSubmission.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async findByIdWithResults(id: string) {
    return this.prisma.campaignSubmission.findFirst({
      where: { id, deletedAt: null },
      include: {
        campaignResults: {
          where: { deletedAt: null },
          include: {
            campaignResultFiles: true,
          },
        },
      },
    });
  }

  private static readonly submissionListInclude = {
    campaignResults: {
      where: { deletedAt: null },
      include: { campaignResultFiles: true },
    },
  } as const;

  async findByCampaignIdPaginated(params: {
    campaignId: string;
    filters: {
      status?: number;
      submittedBy?: string;
      search?: string;
    };
    skip: number;
    take: number;
    sortBy: "createdAt" | "updatedAt" | "title";
    sortOrder: "asc" | "desc";
  }) {
    const { campaignId, filters, skip, take, sortBy, sortOrder } = params;

    const where: Prisma.CampaignSubmissionWhereInput = {
      campaignId,
      deletedAt: null,
      ...(filters.status !== undefined ? { status: filters.status } : {}),
      ...(filters.submittedBy ? { submittedBy: filters.submittedBy } : {}),
      ...(filters.search
        ? {
            title: {
              contains: filters.search,
              mode: Prisma.QueryMode.insensitive,
            },
          }
        : {}),
    };

    const orderBy: Prisma.CampaignSubmissionOrderByWithRelationInput =
      sortBy === "title"
        ? { title: sortOrder }
        : sortBy === "updatedAt"
          ? { updatedAt: sortOrder }
          : { createdAt: sortOrder };

    const [rows, total] = await Promise.all([
      this.prisma.campaignSubmission.findMany({
        where,
        include: CampaignSubmissionRepository.submissionListInclude,
        orderBy,
        skip,
        take,
      }),
      this.prisma.campaignSubmission.count({ where }),
    ]);
    return { rows, total };
  }

  async updateStatus(id: string, status: number) {
    return this.prisma.campaignSubmission.update({
      where: { id },
      data: { status },
    });
  }

  async softDelete(id: string) {
    return this.prisma.campaignSubmission.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /** Results for this campaign not yet linked to any submission (draft / current). */
  async findUnsubmittedResultsByCampaignId(campaignId: string) {
    return this.prisma.campaignResult.findMany({
      where: {
        campaignId,
        campaignSubmissionId: { equals: null },
        deletedAt: null,
      },
      include: { campaignResultFiles: true },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Attach all draft results for the campaign to a new submission. */
  async attachUnsubmittedResultsToSubmission(
    campaignId: string,
    submissionId: string,
    updatedBy: string,
  ) {
    return this.prisma.campaignResult.updateMany({
      where: {
        campaignId,
        campaignSubmissionId: { equals: null },
        deletedAt: null,
      },
      data: {
        campaignSubmissionId: submissionId,
        updatedBy,
      },
    });
  }
}

export const campaignSubmissionRepository =
  new CampaignSubmissionRepository();
