import prisma from "../../config/prisma.client";
import {
  DifficultyResponse,
  toDifficultyResponse,
  UpdateDifficultyBody,
} from "./difficulty.dto";
import { translateText } from "../translation/translation.client";

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
    authorization?: string,
  ): Promise<DifficultyResponse | null> {
    const existing = await prisma.difficulty.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) {
      return null;
    }

    const sourceText =
      body.nameVi?.trim() || body.nameEn?.trim() || body.name?.trim() || "";
    let nameVi = body.nameVi?.trim();
    let nameEn = body.nameEn?.trim();
    if (sourceText && (!nameVi || !nameEn)) {
      const tr = await translateText(sourceText, authorization);
      nameVi = nameVi ?? tr.vi;
      nameEn = nameEn ?? tr.en;
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
    return { ...toDifficultyResponse(updated), name: null as any };
  }
}

export const difficultyService = new DifficultyService();
