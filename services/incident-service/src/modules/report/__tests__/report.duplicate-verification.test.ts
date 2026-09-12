const findByIdMock = jest.fn();
const updateMock = jest.fn();
const prepareMediaFromUrlMock = jest.fn();
const enqueueMock = jest.fn().mockResolvedValue(undefined);
const transactionMock = jest.fn(
  async (cb: (tx: {
    media: { create: jest.Mock };
    reportMediaFile: { create: jest.Mock };
  }) => unknown) =>
    cb({
      media: { create: jest.fn().mockResolvedValue({ id: "media-1" }) },
      reportMediaFile: {
        create: jest.fn().mockResolvedValue({ id: "rmf-1" }),
      },
    }),
);

jest.mock("../../../queue/register", () => ({
  backgroundJobDispatcher: { enqueue: (...args: unknown[]) => enqueueMock(...args) },
}));

jest.mock("../../../config/prisma.client", () => ({
  __esModule: true,
  default: { $transaction: transactionMock },
}));

jest.mock("../../../outbox/outbox.writer", () => ({
  emitOutbox: jest.fn(),
}));

jest.mock("../../media/media-from-url.service", () => ({
  prepareMediaFromUrl: (...args: unknown[]) =>
    prepareMediaFromUrlMock(...args),
  toReportSubmittedMediaSnapshot: jest.fn(),
}));

jest.mock("../../organization/identity-user.client", () => ({
  fetchOrganizationOwnersByUserIds: jest.fn().mockResolvedValue(new Map()),
  isIdentityCallableUserId: () => false,
  getUserProfile: jest.fn(),
}));

jest.mock("../../vote/vote.service", () => ({
  voteService: {
    getVoteSummariesForResources: jest.fn().mockResolvedValue(new Map()),
  },
}));

jest.mock("../../saved_resource/saved_resource.repository", () => ({
  savedResourceRepository: {
    findActiveSavedResourceIdsForUser: jest.fn().mockResolvedValue(new Set()),
  },
}));

jest.mock("../report.repository", () => ({
  reportRepository: {
    findById: (...args: unknown[]) => findByIdMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

jest.mock("../report.entity", () => ({
  toReportResponse: (r: unknown) => r,
  toDuplicateVerificationJson: (v: unknown) => v,
}));

import { Prisma } from "@prisma/client";
import { HTTP_STATUS } from "../../../constants/http-status";
import { reportService } from "../report.service";

describe("saveDuplicateVerification", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("throws REPORT_NOT_FOUND when the report is missing", async () => {
    findByIdMock.mockResolvedValue(null);
    await expect(
      reportService.saveDuplicateVerification("r-missing", {
        duplicateReportId: null,
        reason: null,
        matches: [],
      }),
    ).rejects.toMatchObject({
      statusResponse: HTTP_STATUS.REPORT_NOT_FOUND,
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("overwrites JSON on an existing report", async () => {
    findByIdMock.mockResolvedValue({ id: "r-new" });
    updateMock.mockResolvedValue({ id: "r-new" });
    const verification = {
      duplicateReportId: "r-old",
      reason: "DUPLICATE_IMAGE",
      matches: [
        {
          mediaId: "m1",
          duplicateMediaId: "m-old",
          reason: "EXACT_HASH_MATCH",
        },
      ],
    };
    await reportService.saveDuplicateVerification("r-new", verification);
    expect(updateMock).toHaveBeenCalledWith("r-new", {
      duplicateVerification: verification,
    });
  });
});

describe("addReportImages", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prepareMediaFromUrlMock.mockResolvedValue({
      media: { url: "https://cdn.example/a.jpg", type: "REPORT" },
      buffer: null,
    });
    findByIdMock.mockResolvedValue({
      id: "r-new",
      userId: "user-1",
      status: 12,
    });
    updateMock.mockResolvedValue({ id: "r-new", userId: "user-1" });
  });

  it("clears duplicateVerification when adding media", async () => {
    await reportService.addReportImages("r-new", "user-1", {
      imageUrls: ["https://cdn.example/a.jpg"],
    });
    expect(updateMock).toHaveBeenCalledWith("r-new", {
      aiVerified: false,
      status: expect.any(Number),
      duplicateVerification: Prisma.DbNull,
    });
  });
});
