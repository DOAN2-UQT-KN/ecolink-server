import { PrismaClient } from "@prisma/client";
import prisma from "../../../config/prisma.client";
import { JoinRequestStatus } from "../../../constants/status.enum";

export class CampaignJoiningRequestRepository {
    private prisma: PrismaClient;

    constructor() {
        this.prisma = prisma;
    }

    async createJoinRequest(data: { campaignId: string; volunteerId: string }) {
        return this.prisma.campaignJoiningRequest.create({
            data: {
                campaignId: data.campaignId,
                volunteerId: data.volunteerId,
                status: JoinRequestStatus._STATUS_PENDING,
            },
        });
    }

    async findById(id: string) {
        return this.prisma.campaignJoiningRequest.findFirst({
            where: { id, deletedAt: null },
        });
    }

    async findByIdWithCampaign(id: string) {
        return this.prisma.campaignJoiningRequest.findFirst({
            where: { id, deletedAt: null },
            include: {
                campaign: {
                    select: {
                        id: true,
                        title: true,
                        status: true,
                    },
                },
            },
        });
    }

    async findExisting(campaignId: string, volunteerId: string) {
        return this.prisma.campaignJoiningRequest.findFirst({
            where: { campaignId, volunteerId, deletedAt: null },
        });
    }

    async findByCampaignId(campaignId: string) {
        return this.prisma.campaignJoiningRequest.findMany({
            where: { campaignId, deletedAt: null },
            orderBy: { createdAt: "desc" },
        });
    }

    async findByCampaignIdPaginated(
        campaignId: string,
        filters: { status?: number; volunteerId?: string },
        options: {
            skip: number;
            take: number;
            sortBy: "createdAt" | "updatedAt";
            sortOrder: "asc" | "desc";
        },
    ) {
        const where = {
            campaignId,
            deletedAt: null as null,
            ...(filters.status !== undefined ? { status: filters.status } : {}),
            ...(filters.volunteerId ? { volunteerId: filters.volunteerId } : {}),
        };
        const orderBy =
            options.sortBy === "updatedAt"
                ? { updatedAt: options.sortOrder }
                : { createdAt: options.sortOrder };

        const [rows, total] = await Promise.all([
            this.prisma.campaignJoiningRequest.findMany({
                where,
                orderBy,
                skip: options.skip,
                take: options.take,
            }),
            this.prisma.campaignJoiningRequest.count({ where }),
        ]);
        return { rows, total };
    }

    async findPendingByCampaignId(campaignId: string) {
        return this.prisma.campaignJoiningRequest.findMany({
            where: {
                campaignId,
                status: JoinRequestStatus._STATUS_PENDING,
                deletedAt: null,
            },
            orderBy: { createdAt: "desc" },
        });
    }

    async findByVolunteerIdPaginated(
        volunteerId: string,
        filters: { campaignId?: string; status?: number },
        options: {
            skip: number;
            take: number;
            sortBy: "createdAt" | "updatedAt";
            sortOrder: "asc" | "desc";
        },
    ) {
        const where = {
            volunteerId,
            deletedAt: null as null,
            ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
            ...(filters.status !== undefined ? { status: filters.status } : {}),
        };
        const orderBy =
            options.sortBy === "updatedAt"
                ? { updatedAt: options.sortOrder }
                : { createdAt: options.sortOrder };
        const include = {
            campaign: {
                select: {
                    id: true,
                    title: true,
                    status: true,
                },
            },
        };

        const [rows, total] = await Promise.all([
            this.prisma.campaignJoiningRequest.findMany({
                where,
                include,
                orderBy,
                skip: options.skip,
                take: options.take,
            }),
            this.prisma.campaignJoiningRequest.count({ where }),
        ]);
        return { rows, total };
    }

    async updateStatus(id: string, status: number) {
        return this.prisma.campaignJoiningRequest.update({
            where: { id },
            data: { status },
        });
    }

    async softDelete(id: string) {
        return this.prisma.campaignJoiningRequest.update({
            where: { id },
            data: { deletedAt: new Date() },
        });
    }

    async isVolunteerApproved(
        campaignId: string,
        volunteerId: string,
    ): Promise<boolean> {
        const request = await this.prisma.campaignJoiningRequest.findFirst({
            where: {
                campaignId,
                volunteerId,
                status: JoinRequestStatus._STATUS_APPROVED,
                deletedAt: null,
            },
        });
        return !!request;
    }

    async getApprovedVolunteersPaginated(
        campaignId: string,
        filters: { volunteerId?: string },
        options: {
            skip: number;
            take: number;
            sortBy: "createdAt" | "updatedAt";
            sortOrder: "asc" | "desc";
        },
    ) {
        const where = {
            campaignId,
            status: JoinRequestStatus._STATUS_APPROVED,
            deletedAt: null as null,
            ...(filters.volunteerId ? { volunteerId: filters.volunteerId } : {}),
        };
        const orderBy =
            options.sortBy === "updatedAt"
                ? { updatedAt: options.sortOrder }
                : { createdAt: options.sortOrder };

        const [rows, total] = await Promise.all([
            this.prisma.campaignJoiningRequest.findMany({
                where,
                orderBy,
                skip: options.skip,
                take: options.take,
            }),
            this.prisma.campaignJoiningRequest.count({ where }),
        ]);
        return { rows, total };
    }
}

export const campaignJoiningRequestRepository =
    new CampaignJoiningRequestRepository();
