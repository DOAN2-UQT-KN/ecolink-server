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

const notifyRejectedMock = jest.fn().mockResolvedValue(undefined);
const notifyApprovedMock = jest.fn().mockResolvedValue(undefined);

jest.mock("../report-status-notify.client", () => ({
  enqueueReportApprovedWebsiteNotification: (...args: unknown[]) =>
    notifyApprovedMock(...args),
  enqueueReportRejectedWebsiteNotification: (...args: unknown[]) =>
    notifyRejectedMock(...args),
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
      reportService.saveDuplicateVerification("r-missing", []),
    ).rejects.toMatchObject({
      statusResponse: HTTP_STATUS.REPORT_NOT_FOUND,
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("sets status to Banned with reason when duplicate is detected", async () => {
    findByIdMock.mockResolvedValue({
      id: "r-new",
      userId: "u-owner",
      title: "Garbage pile",
      status: 12,
    });
    updateMock.mockResolvedValue({
      id: "r-new",
      userId: "u-owner",
      title: "Garbage pile",
      status: 2,
      rejectReason: "DUPLICATE_IMAGE",
    });
    const verification = [
      {
        duplicateReportId: "r-old",
        matches: [{ mediaId: "m1", duplicateMediaId: "m-old" }],
      },
    ];
    await reportService.saveDuplicateVerification("r-new", verification);
    expect(updateMock).toHaveBeenCalledWith("r-new", {
      duplicateVerification: verification,
      status: 2,
      rejectReason: "DUPLICATE_IMAGE",
    });
    expect(notifyRejectedMock).toHaveBeenCalledWith({
      userId: "u-owner",
      reportId: "r-new",
      reportTitle: "Garbage pile",
      rejectReason: "DUPLICATE_IMAGE",
    });
  });

  it("bans with DUPLICATE_IMAGE when the group array is non-empty", async () => {
    findByIdMock.mockResolvedValue({
      id: "r-new",
      userId: "u-owner",
      status: 12,
    });
    updateMock.mockResolvedValue({
      id: "r-new",
      userId: "u-owner",
      status: 2,
      rejectReason: "DUPLICATE_IMAGE",
    });
    const verification = [
      { duplicateReportId: "r-a", matches: [] },
      { duplicateReportId: "r-b", matches: [] },
    ];
    await reportService.saveDuplicateVerification("r-new", verification);
    expect(updateMock).toHaveBeenCalledWith("r-new", {
      duplicateVerification: verification,
      status: 2,
      rejectReason: "DUPLICATE_IMAGE",
    });
  });

  it("does not change status or rejectReason when unique (no duplicate)", async () => {
    findByIdMock.mockResolvedValue({
      id: "r-new",
      userId: "u-owner",
      status: 12,
      rejectReason: null,
    });
    updateMock.mockResolvedValue({
      id: "r-new",
      userId: "u-owner",
      status: 12,
    });
    const verification: never[] = [];
    await reportService.saveDuplicateVerification("r-new", verification);
    expect(updateMock).toHaveBeenCalledWith("r-new", {
      duplicateVerification: verification,
    });
    expect(notifyRejectedMock).not.toHaveBeenCalled();
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
