import prisma from "../../config/prisma.client";
import {
  DifficultyResponse,
  toDifficultyResponse,
  UpdateDifficultyBody,
} from "./difficulty.dto";
import { backgroundJobDispatcher } from "../../queue/green-point-queue.bootstrap";
import {
  TRANSLATE_TEXT_JOB_TYPE,
  TranslationFieldTarget,
  TranslationResourceType,
} from "../translation/translation.types";

/**
 * Best-effort enqueue of a TRANSLATE_TEXT job. Failure is logged but does NOT
 * propagate so request handlers stay fast and do not roll back the primary
 * write when SQS is unavailable.
 */
function enqueueDifficultyTranslationJob(
  resourceId: string,
  translations: TranslationFieldTarget[],
): void {
  const cleaned = translations.filter(
    (t) => t.sourceText.trim().length > 0 && (t.viField || t.enField),
  );
  if (cleaned.length === 0) {
    return;
  }
  backgroundJobDispatcher
    .enqueue(TRANSLATE_TEXT_JOB_TYPE, {
      resourceType: TranslationResourceType.DIFFICULTY,
      resourceId,
      translations: cleaned,
    })
    .catch((err: Error) => {
      console.error(
        "[reward-service] Failed to enqueue difficulty translation job:",
        err.message,
      );
    });
}

export class DifficultyService {
  async listActive(
    page: number = 1,
    limit: number = 20,
  ): Promise<{ difficulties: DifficultyResponse[]; total: number }> {
    const skip = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      prisma.difficulty.findMany({
        where: { deletedAt: null },
        orderBy: { level: "asc" },
        skip,
        take: limit,
      }),
      prisma.difficulty.count({ where: { deletedAt: null } }),
    ]);
    return {
      difficulties: rows.map((r) => ({ ...toDifficultyResponse(r), name: null as any })),
      total,
    };
  }

  async findByLevel(level: number): Promise<DifficultyResponse | null> {
    const row = await prisma.difficulty.findFirst({
      where: { level, deletedAt: null },
    });
    return row ? { ...toDifficultyResponse(row), name: null as any } : null;
  }

  async updateById(
    id: string,
    body: UpdateDifficultyBody,
    _authorization?: string,
  ): Promise<DifficultyResponse | null> {
    const existing = await prisma.difficulty.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) {
      return null;
    }

    const userNameVi = body.nameVi?.trim() || "";
    const userNameEn = body.nameEn?.trim() || "";
    const sourceText =
      userNameVi || userNameEn || body.name?.trim() || "";

    // Pre-fill any missing language with the source text so the row reads back
    // sensibly until the translation worker overwrites it.
    let nameVi = userNameVi;
    let nameEn = userNameEn;
    if (sourceText) {
      if (!nameVi) nameVi = sourceText;
      if (!nameEn) nameEn = sourceText;
    }

    const updated = await prisma.difficulty.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(nameVi !== undefined ? { nameVi } : {}),
        ...(nameEn !== undefined ? { nameEn } : {}),
        ...(body.maxVolunteers !== undefined
          ? { maxVolunteers: body.maxVolunteers }
          : {}),
        ...(body.greenPoints !== undefined
          ? { greenPoints: body.greenPoints }
          : {}),
      },
    });

    if (sourceText && (!userNameVi || !userNameEn)) {
      enqueueDifficultyTranslationJob(updated.id, [
        {
          sourceText,
          viField: userNameVi ? undefined : "nameVi",
          enField: userNameEn ? undefined : "nameEn",
        },
      ]);
    }

    return { ...toDifficultyResponse(updated), name: null as any };
  }
}

export const difficultyService = new DifficultyService();
