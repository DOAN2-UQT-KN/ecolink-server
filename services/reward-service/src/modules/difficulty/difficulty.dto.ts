import { Difficulty } from "@prisma/client";

export interface DifficultyResponse {
  id: string;
  level: number;
  name: string | null;
  nameVi?: string | null;
  nameEn?: string | null;
  maxVolunteers: number | null;
  /** Suggested minimum volunteers per campaign day. */
  suggestedMinVolunteers: number | null;
  greenPoints: number;
}

export const toDifficultyResponse = (row: Difficulty): DifficultyResponse => ({
  id: row.id,
  level: row.level,
  name: row.nameVi ?? row.name,
  nameVi: row.nameVi ?? row.name,
  nameEn: row.nameEn,
  maxVolunteers: row.maxVolunteers,
  suggestedMinVolunteers: row.suggestedMinVolunteers,
  greenPoints: row.greenPoints,
});

export interface UpdateDifficultyBody {
  name?: string;
  nameVi?: string;
  nameEn?: string;
  maxVolunteers?: number | null;
  suggestedMinVolunteers?: number | null;
  greenPoints?: number;
}

export interface DifficultyListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** OpenAPI / success envelope: list difficulties */
export interface DifficultiesListEnvelopeData extends DifficultyListMeta {
  difficulties: DifficultyResponse[];
}

/** OpenAPI / success envelope: single difficulty */
export interface DifficultyOneEnvelopeData {
  difficulty: DifficultyResponse;
}
