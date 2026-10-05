import { randomUUID } from "node:crypto";
import prisma from "../../config/prisma.client";

/**
 * Registers photos as if uploaded through `result-photos` (Layer 1 already graded), so a shift
 * result may use them. Both sides unless `sides` says otherwise; a fresh hash per row unless given.
 */
export async function allowResultPhotos(
  rows: Array<{
    campaignId: string;
    shiftId: string;
    reportId: string;
    url: string;
    sides?: Array<"before" | "after">;
    level?: "pass" | "warn" | "fail";
    sha256?: string;
    exifTakenAt?: Date | null;
    uploadedBy?: string;
  }>,
): Promise<void> {
  await prisma.resultPhotoCheck.createMany({
    data: rows.flatMap((r) =>
      (r.sides ?? ["before", "after"]).map((side) => ({
        campaignId: r.campaignId,
        shiftId: r.shiftId,
        reportId: r.reportId,
        side,
        url: r.url,
        uploadedBy: r.uploadedBy ?? randomUUID(),
        sha256: r.sha256 ?? randomUUID().replace(/-/g, ""),
        exifTakenAt: r.exifTakenAt ?? null,
        pinLat: 10.77,
        pinLng: 106.7,
        timeCheck: r.level ?? "pass",
        exifLocationCheck: r.level ?? "pass",
        pinCheck: "pass",
        level: r.level ?? "pass",
      })),
    ),
  });
}
