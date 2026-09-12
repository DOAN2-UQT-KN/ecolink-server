import type { Report } from "@prisma/client";
import {
  toDuplicateVerification,
  toDuplicateVerificationJson,
  toReportResponse,
} from "../report.entity";

function baseReport(overrides: Partial<Report> = {}): Report {
  return {
    id: "r-new",
    campaignId: null,
    userId: "u1",
    title: "t",
    titleVi: "t",
    titleEn: "t",
    description: "d",
    descriptionVi: "d",
    descriptionEn: "d",
    wasteType: null,
    severityLevel: 1,
    latitude: 1,
    longitude: 2,
    detailAddress: null,
    status: 12,
    isVerify: false,
    rejectReason: null,
    aiVerified: false,
    aiRecommendation: null,
    duplicateVerification: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

describe("toDuplicateVerification", () => {
  it("returns null when unset", () => {
    expect(toDuplicateVerification(null)).toBeNull();
    expect(toDuplicateVerification(undefined)).toBeNull();
  });

  it("maps a hit (camelCase)", () => {
    expect(
      toDuplicateVerification({
        duplicateReportId: "r-old",
        reason: "DUPLICATE_IMAGE",
        matches: [
          {
            mediaId: "m1",
            duplicateMediaId: "m-old",
            reason: "EXACT_HASH_MATCH",
          },
        ],
      }),
    ).toEqual({
      duplicateReportId: "r-old",
      reason: "DUPLICATE_IMAGE",
      matches: [
        {
          mediaId: "m1",
          duplicateMediaId: "m-old",
          reason: "EXACT_HASH_MATCH",
        },
      ],
    });
  });

  it("maps a miss (snake_case)", () => {
    expect(
      toDuplicateVerification({
        duplicate_report_id: null,
        reason: null,
        matches: [],
      }),
    ).toEqual({
      duplicateReportId: null,
      reason: null,
      matches: [],
    });
  });

  it("maps legacy reasons[] detect codes to final DUPLICATE_IMAGE", () => {
    expect(
      toDuplicateVerification({
        duplicateReportId: "r-old",
        reasons: ["EXACT_HASH_MATCH"],
        matches: [{ mediaId: "m1", duplicateMediaId: "m-old" }],
      }),
    ).toEqual({
      duplicateReportId: "r-old",
      reason: "DUPLICATE_IMAGE",
      matches: [{ mediaId: "m1", duplicateMediaId: "m-old", reason: "" }],
    });
  });

  it("derives final reason from match detect reasons when top-level reason is missing", () => {
    expect(
      toDuplicateVerification({
        duplicate_report_id: "r-old",
        matches: [
          {
            media_id: "m1",
            duplicate_media_id: "m-old",
            reason: "HIGH_IMAGE_SIMILARITY",
          },
        ],
      }),
    ).toEqual({
      duplicateReportId: "r-old",
      reason: "DUPLICATE_IMAGE",
      matches: [
        {
          mediaId: "m1",
          duplicateMediaId: "m-old",
          reason: "HIGH_IMAGE_SIMILARITY",
        },
      ],
    });
  });
});

describe("toReportResponse", () => {
  it("exposes null duplicateVerification before AI write-back", () => {
    const response = toReportResponse(baseReport());
    expect(response.duplicateVerification).toBeNull();
  });

  it("exposes hit after write-back", () => {
    const stored = toDuplicateVerificationJson({
      duplicateReportId: "r-old",
      reason: "DUPLICATE_IMAGE",
      matches: [
        {
          mediaId: "m1",
          duplicateMediaId: "m-old",
          reason: "HIGH_IMAGE_SIMILARITY",
        },
      ],
    });
    const response = toReportResponse(
      baseReport({ duplicateVerification: stored as Report["duplicateVerification"] }),
    );
    expect(response.duplicateVerification).toEqual({
      duplicateReportId: "r-old",
      reason: "DUPLICATE_IMAGE",
      matches: [
        {
          mediaId: "m1",
          duplicateMediaId: "m-old",
          reason: "HIGH_IMAGE_SIMILARITY",
        },
      ],
    });
  });
});
