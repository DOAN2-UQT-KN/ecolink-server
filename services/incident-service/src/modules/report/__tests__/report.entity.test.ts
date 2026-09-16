import type { Report } from "@prisma/client";
import {
  embedDuplicateVerification,
  omitInactiveDuplicateGroups,
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

  it("returns an empty array for a unique check", () => {
    expect(toDuplicateVerification([])).toEqual([]);
  });

  it("maps a stored group array", () => {
    expect(
      toDuplicateVerification([
        {
          duplicateReportId: "r-a",
          matches: [{ mediaId: "m-new", duplicateMediaId: "m-old" }],
        },
      ]),
    ).toEqual([
      {
        duplicateReportId: "r-a",
        matches: [{ mediaId: "m-new", duplicateMediaId: "m-old" }],
      },
    ]);
  });

  it("groups a legacy singular-id object and drops reason", () => {
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
    ).toEqual([
      {
        duplicateReportId: "r-old",
        matches: [{ mediaId: "m1", duplicateMediaId: "m-old" }],
      },
    ]);
  });

  it("groups a legacy id list by match report id", () => {
    expect(
      toDuplicateVerification({
        duplicate_report_ids: ["r-a", "r-b"],
        reason: "DUPLICATE_IMAGE",
        matches: [
          {
            media_id: "m-new-1",
            duplicate_media_id: "m-old-a",
            duplicate_report_id: "r-a",
            reason: "EXACT_HASH_MATCH",
          },
          {
            media_id: "m-new-2",
            duplicate_media_id: "m-old-b",
            duplicate_report_id: "r-b",
          },
        ],
      }),
    ).toEqual([
      {
        duplicateReportId: "r-a",
        matches: [{ mediaId: "m-new-1", duplicateMediaId: "m-old-a" }],
      },
      {
        duplicateReportId: "r-b",
        matches: [{ mediaId: "m-new-2", duplicateMediaId: "m-old-b" }],
      },
    ]);
  });

  it("maps a legacy unique object to an empty array", () => {
    expect(
      toDuplicateVerification({
        duplicate_report_id: null,
        reason: null,
        matches: [],
      }),
    ).toEqual([]);
  });
});

describe("toReportResponse", () => {
  it("exposes null duplicateVerification before AI write-back", () => {
    const response = toReportResponse(baseReport());
    expect(response.duplicateVerification).toBeNull();
  });

  it("exposes hit after write-back", () => {
    const stored = toDuplicateVerificationJson([
      {
        duplicateReportId: "r-old",
        matches: [{ mediaId: "m1", duplicateMediaId: "m-old" }],
      },
    ]);
    const response = toReportResponse(
      baseReport({ duplicateVerification: stored as Report["duplicateVerification"] }),
    );
    expect(response.duplicateVerification).toEqual([
      {
        duplicateReportId: "r-old",
        title: null,
        detailAddress: null,
        status: null,
        matches: [
          {
            newMedia: { mediaId: "m1", url: null },
            duplicateMedia: { duplicateMediaId: "m-old", duplicateUrl: null },
          },
        ],
      },
    ]);
  });
});

describe("omitInactiveDuplicateGroups", () => {
  const groups = [
    {
      duplicateReportId: "r-live",
      matches: [{ mediaId: "m-new", duplicateMediaId: "m-live" }],
    },
    {
      duplicateReportId: "r-banned",
      matches: [{ mediaId: "m-new", duplicateMediaId: "m-banned" }],
    },
    {
      duplicateReportId: "r-missing",
      matches: [{ mediaId: "m-new", duplicateMediaId: "m-gone" }],
    },
  ];

  it("keeps a live report and drops banned or missing reports", () => {
    expect(
      omitInactiveDuplicateGroups(
        groups,
        new Map([
          ["r-live", { status: 12 }],
          ["r-banned", { status: 2 }],
        ]),
      ),
    ).toEqual([groups[0]]);
  });
});

describe("embedDuplicateVerification", () => {
  it("attaches report summary and media urls without changing stored ids", () => {
    expect(
      embedDuplicateVerification(
        [
          {
            duplicateReportId: "r-a",
            matches: [{ mediaId: "m-new", duplicateMediaId: "m-old" }],
          },
        ],
        new Map([
          [
            "r-a",
            {
              title: "fallback",
              titleVi: "Older pile",
              detailAddress: "12 Street",
              status: 2,
            },
          ],
        ]),
        new Map([
          ["m-new", "https://cdn.example/new.jpg"],
          ["m-old", "https://cdn.example/old.jpg"],
        ]),
      ),
    ).toEqual([
      {
        duplicateReportId: "r-a",
        title: "Older pile",
        detailAddress: "12 Street",
        status: 2,
        matches: [
          {
            newMedia: {
              mediaId: "m-new",
              url: "https://cdn.example/new.jpg",
            },
            duplicateMedia: {
              duplicateMediaId: "m-old",
              duplicateUrl: "https://cdn.example/old.jpg",
            },
          },
        ],
      },
    ]);
  });

  it("returns null fields when the older report or media is missing", () => {
    expect(
      embedDuplicateVerification(
        [
          {
            duplicateReportId: "missing",
            matches: [{ mediaId: "m-new", duplicateMediaId: "gone" }],
          },
        ],
        new Map(),
        new Map([["m-new", "https://cdn.example/new.jpg"]]),
      ),
    ).toEqual([
      {
        duplicateReportId: "missing",
        title: null,
        detailAddress: null,
        status: null,
        matches: [
          {
            newMedia: { mediaId: "m-new", url: "https://cdn.example/new.jpg" },
            duplicateMedia: { duplicateMediaId: "gone", duplicateUrl: null },
          },
        ],
      },
    ]);
  });
});
