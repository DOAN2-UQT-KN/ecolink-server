import axios from "axios";
import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { ReportStatus } from "../../constants/status.enum";
import { reportRepository } from "./report.repository";

interface AiAnalyzeResponse {
  success?: boolean;
  data?: {
    detectedWasteType?: string;
    wasteType?: string;
    confidence?: number;
    boundingBox?: unknown;
  };
}

export class ReportAiAnalysisService {
  private readonly aiServiceUrl = process.env.AI_SERVICE_URL;

  async analyzeReport(reportId: string, mediaFiles: string[]): Promise<void> {
    if (!this.aiServiceUrl) {
      throw new Error("AI_SERVICE_URL is not configured");
    }

    const response = await axios.post<AiAnalyzeResponse>(
      `${this.aiServiceUrl}/api/v1/analyze`,
      {
        reportId,
        images: mediaFiles,
      },
      {
        timeout: 15_000,
      },
    );

    const responseData = response.data?.data;
    const detectedWasteType =
      responseData?.detectedWasteType ?? responseData?.wasteType;
    const confidence =
      typeof responseData?.confidence === "number"
        ? responseData.confidence
        : null;

    if (response.data?.success !== false) {
      await reportRepository.update(reportId, {
        wasteType: detectedWasteType,
        status: ReportStatus.IN_PROGRESS,
        aiVerified: true,
      });
    }

    await prisma.aiAnalysisLog.create({
      data: {
        reportId,
        detectedWasteType: detectedWasteType ?? null,
        confidence,
        boundingBox:
          responseData?.boundingBox !== undefined
            ? (responseData.boundingBox as Prisma.InputJsonValue)
            : Prisma.JsonNull,
      },
    });
  }
}

export const reportAiAnalysisService = new ReportAiAnalysisService();
