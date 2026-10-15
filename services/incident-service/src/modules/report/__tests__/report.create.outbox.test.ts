/**
 * Producer-side outbox tests for `createReport` → REPORT_SUBMITTED.
 */

const txFake = {
  report: {
    create: jest.fn(),
  },
  media: {
    createMany: jest.fn(),
  },
  reportMediaFile: {
    createMany: jest.fn(),
  },
};
const transactionMock = jest.fn(
  async (cb: (tx: typeof txFake) => unknown) => cb(txFake),
);
const enqueueMock = jest.fn().mockResolvedValue(undefined);
const emitOutboxMock = jest.fn().mockResolvedValue(undefined);
const prepareMediaFromUrlMock = jest.fn();
const gateMock = {
  assertInServiceArea: jest.fn().mockResolvedValue(undefined),
  assertUnderRateLimit: jest.fn().mockResolvedValue(undefined),
  lockUserForSubmit: jest.fn().mockResolvedValue(undefined),
  findByIdempotencyKey: jest.fn().mockResolvedValue(null),
};

// The submit rules need a real DB; they are covered by src/__it__/report-submit-gate.it.test.ts.
jest.mock("../report-submit-gate", () => gateMock);

jest.mock("../../../queue/register", () => ({
  backgroundJobDispatcher: { enqueue: enqueueMock },
}));

jest.mock("../../../config/prisma.client", () => ({
  __esModule: true,
  default: { $transaction: transactionMock },
}));

jest.mock("../../../outbox/outbox.writer", () => ({
  emitOutbox: (...args: unknown[]) => emitOutboxMock(...args),
}));

jest.mock("../../media/media-from-url.service", () => ({
  buildMediaCreateData: jest.requireActual("../../media/media-from-url.service").buildMediaCreateData,
  emptyExtracted: jest.requireActual("../../media/media-from-url.service").emptyExtracted,
  prepareMediaFromUrl: (...args: unknown[]) =>
    prepareMediaFromUrlMock(...args),
  toReportSubmittedMediaSnapshot: (input: {
    reportMediaFileId: string;
    mediaId: string;
    uploadedBy: string | null;
    media: { id?: string; url: string; type: string };
  }) => ({
    reportMediaFileId: input.reportMediaFileId,
    mediaId: input.mediaId,
    uploadedBy: input.uploadedBy,
    url: input.media.url,
    type: input.media.type,
    mimeType: null,
    fileSize: null,
    width: null,
    height: null,
    capturedAt: null,
    latitude: null,
    longitude: null,
    cameraMake: null,
    cameraModel: null,
    metadata: null,
  }),
}));

jest.mock("../report.entity", () => ({
  toReportResponse: (r: unknown) => r,
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

import { reportService } from "../report.service";
import { OutboxEventType } from "../../../outbox/outbox.types";

describe("createReport (outbox producer)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    enqueueMock.mockResolvedValue(undefined);
    emitOutboxMock.mockResolvedValue(undefined);
    prepareMediaFromUrlMock.mockImplementation(
      async (input: { id?: string; url: string; type: string }) => ({
        media: {
          id: input.id ?? "media-1",
          url: input.url,
          type: input.type,
          createdBy: "user-1",
          updatedBy: "user-1",
        },
        buffer: null,
      }),
    );
    txFake.report.create.mockResolvedValue({
      id: "report-new",
      userId: "user-1",
      title: "Trash nearby",
    });
    txFake.media.createMany.mockResolvedValue({ count: 1 });
    txFake.reportMediaFile.createMany.mockResolvedValue({ count: 1 });
  });

  it("emit REPORT_SUBMITTED đúng payload + dedupKey trong cùng transaction", async () => {
    const result = await reportService.createReport("user-1", {
      title: "Trash nearby",
      latitude: 1,
      longitude: 2,
      imageUrls: ["https://cdn.example/a.jpg"],
      wasteType: "household,abc",
    });

    expect(result.replayed).toBe(false);
    // FR-005: images are not downloaded while handling the request.
    expect(prepareMediaFromUrlMock).not.toHaveBeenCalled();
    expect(gateMock.assertInServiceArea).toHaveBeenCalledWith(expect.anything(), 1, 2);
    expect(gateMock.lockUserForSubmit).toHaveBeenCalledWith(txFake, "user-1");
    expect(gateMock.assertUnderRateLimit).toHaveBeenCalledWith(txFake, "user-1", expect.any(Date));
    expect(txFake.report.create.mock.calls[0][0].data).toMatchObject({
      category: "OTHER",
      wasteTypes: ["HOUSEHOLD"],
      wasteType: "household",
      idempotencyKey: null,
    });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(emitOutboxMock).toHaveBeenCalledTimes(1);
    const [tx, event] = emitOutboxMock.mock.calls[0];
    expect(tx).toBe(txFake);
    expect(event.aggregateType).toBe("report");
    expect(event.aggregateId).toBe("report-new");
    expect(event.eventType).toBe(OutboxEventType.REPORT_SUBMITTED);
    expect(event.dedupKey).toBe("REPORT_SUBMITTED:report-new:1");
    expect(event.payload).toMatchObject({
      reportId: "report-new",
      userId: "user-1",
      attempt: 1,
    });
    expect(Array.isArray(event.payload.reportMediaFileIds)).toBe(true);
    expect(event.payload.reportMediaFileIds).toHaveLength(1);
    expect(Array.isArray(event.payload.media)).toBe(true);
    expect(event.payload.media).toHaveLength(1);
    expect(event.payload.media[0]).toMatchObject({
      url: "https://cdn.example/a.jpg",
      type: expect.any(String),
      mediaId: expect.any(String),
      reportMediaFileId: expect.any(String),
      mimeType: null,
    });
  });

  it("replays an existing report for a known Idempotency-Key without writing", async () => {
    gateMock.findByIdempotencyKey.mockResolvedValueOnce({ id: "report-old", userId: "user-1" });
    const result = await reportService.createReport(
      "user-1",
      { title: "x", latitude: 1, longitude: 2, imageUrls: ["https://cdn.example/a.jpg"] },
      undefined,
      "8f1d7f4e-2a51-4c4b-9a0e-0d5f3b8e6c11",
    );
    expect(result).toMatchObject({ replayed: true, report: { id: "report-old" } });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(gateMock.assertInServiceArea).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("vẫn enqueue ANALYZE_REPORT sau commit (path song song không bị gỡ)", async () => {
    await reportService.createReport("user-1", {
      title: "Trash nearby",
      latitude: 1,
      longitude: 2,
      imageUrls: ["https://cdn.example/a.jpg"],
    });
    expect(enqueueMock).toHaveBeenCalled();
  });
});
