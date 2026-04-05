import { campaignSubmissionRepository } from "./campaign_submission.repository";
import { campaignManagerRepository } from "../campaign_manager/campaign_manager.repository";
import { ResultStatus } from "../../../constants/status.enum";
import prisma from "../../../config/prisma.client";
import type { CampaignSubmissionsListQuery } from "./campaign_submission.dto";

// ─── Request DTOs ────────────────────────────────────────────────────────────

/** Body for POST .../submissions — draft results are loaded from the DB, not from this payload. */
export interface CreateSubmissionRequest {
  title?: string;
  description?: string;
}

export interface CreateResultRequest {
  title: string;
  description?: string;
  mediaUrls?: string[]; // image/file URLs for this result
}

export interface UpdateSubmissionRequest {
  title?: string;
  description?: string;
}

// ─── Response DTOs ───────────────────────────────────────────────────────────

export interface SubmissionResponse {
  id: string;
  campaignId: string;
  submittedBy: string;
  title: string | null;
  description: string | null;
  status: number;
  createdAt: Date;
  updatedAt: Date;
  results?: ResultResponse[];
}

export interface ResultResponse {
  id: string;
  campaignId: string;
  campaignSubmissionId: string | null;
  title: string;
  description: string | null;
  createdAt: Date;
  files: ResultFileResponse[];
}

export interface ResultFileResponse {
  id: string;
  campaignResultId: string;
  mediaId: string;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class CampaignSubmissionService {
  constructor() { }

  /**
   * Create a submission for a campaign and attach all draft campaign results from the DB.
   * Only campaign managers can submit.
   */
  async createSubmission(
    campaignId: string,
    managerId: string,
    request: CreateSubmissionRequest,
  ): Promise<SubmissionResponse> {
    const isManager = await campaignManagerRepository.isManager(
      campaignId,
      managerId,
    );
    if (!isManager) {
      throw new Error("Only campaign managers can create submissions");
    }

    const submission = await campaignSubmissionRepository.create({
      campaignId,
      submittedBy: managerId,
      title: request.title,
      description: request.description,
    });

    await campaignSubmissionRepository.attachUnsubmittedResultsToSubmission(
      campaignId,
      submission.id,
      managerId,
    );

    const full = await campaignSubmissionRepository.findByIdWithResults(
      submission.id,
    );
    return this.toResponse(full!);
  }

  /**
   * Add a single CampaignResult (with files) to an existing submission.
   */
  async addResultToSubmission(
    submissionId: string,
    managerId: string,
    request: CreateResultRequest,
  ): Promise<ResultResponse> {
    const submission =
      await campaignSubmissionRepository.findById(submissionId);
    if (!submission) throw new Error("Submission not found");
    if (submission.submittedBy !== managerId) {
      throw new Error("Only the submitter can add results to this submission");
    }

    const result = await prisma.campaignResult.create({
      data: {
        campaignId: submission.campaignId,
        campaignSubmissionId: submissionId,
        title: request.title,
        description: request.description,
        createdBy: managerId,
        updatedBy: managerId,
      },
    });

    const files: ResultFileResponse[] = [];

    // Persist media records and link them
    if (request.mediaUrls && request.mediaUrls.length > 0) {
      for (const url of request.mediaUrls) {
        const media = await prisma.media.create({
          data: { url, type: "CAMPAIGN_RESULT", createdBy: managerId, updatedBy: managerId },
        });
        const file = await prisma.campaignResultFile.create({
          data: {
            campaignResultId: result.id,
            mediaId: media.id,
            createdBy: managerId,
            updatedBy: managerId,
          },
        });
        files.push({ id: file.id, campaignResultId: file.campaignResultId, mediaId: file.mediaId });
      }
    }

    return {
      id: result.id,
      campaignId: result.campaignId,
      campaignSubmissionId: result.campaignSubmissionId,
      title: result.title,
      description: result.description,
      createdAt: result.createdAt,
      files,
    };
  }

  /**
   * Draft results for a campaign (not yet included in any submission).
   */
  async getUnsubmittedResults(
    campaignId: string,
  ): Promise<ResultResponse[]> {
    const rows =
      await campaignSubmissionRepository.findUnsubmittedResultsByCampaignId(
        campaignId,
      );
    return rows.map((r) => this.resultToResponse(r));
  }

  /**
   * List submissions for a campaign with optional filters and pagination.
   */
  async getSubmissionsByCampaign(
    campaignId: string,
    query: CampaignSubmissionsListQuery,
  ): Promise<{
    submissions: SubmissionResponse[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const sortBy = query.sortBy ?? "createdAt";
    const sortOrder = query.sortOrder ?? "desc";
    const skip = (page - 1) * limit;

    const { rows, total } =
      await campaignSubmissionRepository.findByCampaignIdPaginated({
        campaignId,
        filters: {
          status: query.status,
          submittedBy: query.submittedBy,
          search: query.search,
        },
        skip,
        take: limit,
        sortBy,
        sortOrder,
      });

    return {
      submissions: rows.map((s) => this.toResponse(s)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get a single submission with all its results.
   */
  async getSubmissionDetail(id: string): Promise<SubmissionResponse | null> {
    const submission =
      await campaignSubmissionRepository.findByIdWithResults(id);
    return submission ? this.toResponse(submission) : null;
  }

  /**
   * Approve or reject a submission.
   * Only campaign managers can approve/reject.
   */
  async processSubmission(
    submissionId: string,
    managerId: string,
    approved: boolean,
  ): Promise<SubmissionResponse> {
    const submission =
      await campaignSubmissionRepository.findById(submissionId);
    if (!submission) throw new Error("Submission not found");

    const isManager = await campaignManagerRepository.isManager(
      submission.campaignId,
      managerId,
    );
    if (!isManager) {
      throw new Error("Only campaign managers can process submissions");
    }

    if (submission.status !== ResultStatus._STATUS_WAITING_APPROVED) {
      throw new Error("Submission already processed");
    }

    const newStatus = approved
      ? ResultStatus._STATUS_APPROVED
      : ResultStatus._STATUS_REJECTED;
    const updated = await campaignSubmissionRepository.updateStatus(
      submissionId,
      newStatus,
    );

    return this.toResponse(updated);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private toResponse(submission: any): SubmissionResponse {
    return {
      id: submission.id,
      campaignId: submission.campaignId,
      submittedBy: submission.submittedBy,
      title: submission.title,
      description: submission.description,
      status: submission.status,
      createdAt: submission.createdAt,
      updatedAt: submission.updatedAt,
      results: submission.campaignResults?.map((r: any) =>
        this.resultToResponse(r),
      ),
    };
  }

  private resultToResponse(r: any): ResultResponse {
    return {
      id: r.id,
      campaignId: r.campaignId,
      campaignSubmissionId: r.campaignSubmissionId,
      title: r.title,
      description: r.description,
      createdAt: r.createdAt,
      files: (r.campaignResultFiles ?? []).map((f: any) => ({
        id: f.id,
        campaignResultId: f.campaignResultId,
        mediaId: f.mediaId,
      })),
    };
  }
}

export const campaignSubmissionService = new CampaignSubmissionService();
