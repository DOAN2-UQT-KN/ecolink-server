import { WasteType } from "@prisma/client";
import type { CreateReportRequest, NormalizedCreateReport } from "./report.dto";

const WASTE_TYPES = new Set<string>(Object.values(WasteType));

/**
 * Folds the legacy create body (`imageUrls`, CSV `wasteType`, no `category`) into the new
 * shape, so clients released before spec 007 keep working. Pure; validation runs before it.
 */
export function normalizeCreateReportInput(req: CreateReportRequest): NormalizedCreateReport {
  const images = req.images
    ? req.images.map((img) => ({ url: img.url.trim(), captureId: img.captureId ?? null }))
    : (req.imageUrls ?? []).map((url) => ({ url: url.trim(), captureId: null }));

  const rawWasteTypes = req.wasteTypes ?? (req.wasteType ?? "").split(",").map((w) => w.trim().toUpperCase());
  const wasteTypes = [...new Set(rawWasteTypes)].filter((w): w is WasteType => WASTE_TYPES.has(w));

  return {
    category: req.category ?? "OTHER",
    wasteTypes,
    wasteTypeCsv: wasteTypes.length > 0 ? wasteTypes.map((w) => w.toLowerCase()).join(",") : null,
    images,
  };
}
