/**
 * Các bất biến của bước nộp hồ sơ: hồ sơ luôn gắn với đúng hòm mail đã xác thực,
 * giấy tờ phải thuộc về hòm mail đó, và một người đại diện không đứng tên quá hạn mức.
 */

const findOpenByContactEmailMock = jest.fn();
const countOpenByLegalRepHashMock = jest.fn();
const findLegalRepLimitOverrideMock = jest.fn();
const findDocumentsByIdsMock = jest.fn();
const countUnattachedDocumentsMock = jest.fn();
const createMock = jest.fn();
const createDocumentMock = jest.fn();
const attachDocumentsMock = jest.fn();
const recordEventMock = jest.fn();
const consumeSubmissionTokenMock = jest.fn();
const issueTrackingTokenMock = jest.fn();
const receivedEmailMock = jest.fn();
const createSignedUploadMock = jest.fn();

jest.mock("../organization-application.repository", () => ({
  organizationApplicationRepository: {
    findOpenByContactEmail: (...a: unknown[]) => findOpenByContactEmailMock(...a),
    countOpenByLegalRepHash: (...a: unknown[]) => countOpenByLegalRepHashMock(...a),
    findLegalRepLimitOverride: (...a: unknown[]) => findLegalRepLimitOverrideMock(...a),
    findDocumentsByIds: (...a: unknown[]) => findDocumentsByIdsMock(...a),
    countUnattachedDocuments: (...a: unknown[]) => countUnattachedDocumentsMock(...a),
    create: (...a: unknown[]) => createMock(...a),
    createDocument: (...a: unknown[]) => createDocumentMock(...a),
    attachDocuments: (...a: unknown[]) => attachDocumentsMock(...a),
    recordEvent: (...a: unknown[]) => recordEventMock(...a),
  },
}));

jest.mock("../organization-application-otp.service", () => ({
  organizationApplicationOtpService: {
    consumeSubmissionToken: (...a: unknown[]) => consumeSubmissionTokenMock(...a),
    issueTrackingToken: (...a: unknown[]) => issueTrackingTokenMock(...a),
  },
}));

jest.mock("../organization-application-notify.client", () => ({
  enqueueApplicationReceivedEmail: (...a: unknown[]) => receivedEmailMock(...a),
}));

jest.mock("../storage/cloudinary-document-storage", () => ({
  documentStorage: {
    createSignedUpload: (...a: unknown[]) => createSignedUploadMock(...a),
  },
}));

import { organizationApplicationService } from "../organization-application.service";
import type { CreateApplicationBody } from "../organization-application.dto";

const EMAIL = "clb@uit.edu.vn";

const validBody = (): CreateApplicationBody => ({
  orgType: "CLUB",
  profile: {
    name: "CLB Tình nguyện UIT",
    contactEmail: EMAIL,
    logoUrl: "https://res.cloudinary.com/demo/logo.png",
  },
  channels: [{ type: "FACEBOOK_PAGE", url: "https://facebook.com/clbtn" }],
  legalRepresentative: {
    fullName: "Nguyen Van A",
    idType: "MSSV",
    idNumber: "22520001",
    phone: "0900000000",
  },
  documentIds: [],
  consent: true,
});

describe("OrganizationApplicationService.createApplication", () => {
  beforeEach(() => {
    findOpenByContactEmailMock.mockResolvedValue(null);
    countOpenByLegalRepHashMock.mockResolvedValue(0);
    findLegalRepLimitOverrideMock.mockResolvedValue(null);
    findDocumentsByIdsMock.mockResolvedValue([]);
    attachDocumentsMock.mockResolvedValue(undefined);
    recordEventMock.mockResolvedValue(undefined);
    consumeSubmissionTokenMock.mockResolvedValue(EMAIL);
    issueTrackingTokenMock.mockResolvedValue({ token: "track-token" });
    receivedEmailMock.mockResolvedValue(undefined);
    createMock.mockImplementation(async (data: Record<string, unknown>) => ({
      ...data,
      id: "app-1",
      createdAt: new Date(),
      reviewedAt: null,
      organizationId: null,
      reviewNote: null,
      rejectReason: null,
    }));
  });

  it("lưu số giấy tờ tuỳ thân dưới dạng hash + 4 số cuối, không lưu số thô", async () => {
    await organizationApplicationService.createApplication(
      EMAIL,
      "sub-token",
      validBody(),
    );

    const row = createMock.mock.calls[0][0];
    expect(row.legalRepIdLast4).toBe("0001");
    expect(row.legalRepIdHash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain("22520001");
  });

  it("kế thừa xác thực email từ OTP và đốt submission token", async () => {
    await organizationApplicationService.createApplication(
      EMAIL,
      "sub-token",
      validBody(),
    );

    expect(createMock.mock.calls[0][0].emailVerifiedAt).toBeInstanceOf(Date);
    expect(consumeSubmissionTokenMock).toHaveBeenCalledWith("sub-token");
  });

  it("từ chối khi contact_email trong body khác hòm mail đã xác thực", async () => {
    const body = validBody();
    body.profile.contactEmail = "someone-else@gmail.com";

    await expect(
      organizationApplicationService.createApplication(EMAIL, "sub-token", body),
    ).rejects.toMatchObject({ statusResponse: { status: 400 } });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("một hòm mail chỉ có một hồ sơ đang mở", async () => {
    findOpenByContactEmailMock.mockResolvedValue({ id: "app-0" });

    await expect(
      organizationApplicationService.createApplication(
        EMAIL,
        "sub-token",
        validBody(),
      ),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_ALREADY_OPEN" },
    });
  });

  it("chặn khi người đại diện đã đứng tên đủ hạn mức", async () => {
    countOpenByLegalRepHashMock.mockResolvedValue(3);

    await expect(
      organizationApplicationService.createApplication(
        EMAIL,
        "sub-token",
        validBody(),
      ),
    ).rejects.toMatchObject({
      statusResponse: { code: "LEGAL_REP_LIMIT_EXCEEDED", status: 422 },
    });
  });

  it("admin nâng hạn mức cho tổ chức thì người đại diện được nộp tiếp", async () => {
    countOpenByLegalRepHashMock.mockResolvedValue(3);
    findLegalRepLimitOverrideMock.mockResolvedValue(5);

    await expect(
      organizationApplicationService.createApplication(
        EMAIL,
        "sub-token",
        validBody(),
      ),
    ).resolves.toMatchObject({
      application: { id: "app-1" },
      trackingToken: "track-token",
    });
  });

  it("không cho gắn giấy tờ của hòm mail khác", async () => {
    const body = validBody();
    body.documentIds = ["11111111-1111-1111-1111-111111111111"];
    findDocumentsByIdsMock.mockResolvedValue([
      { id: body.documentIds[0], submissionEmail: "attacker@gmail.com" },
    ]);

    await expect(
      organizationApplicationService.createApplication(EMAIL, "sub-token", body),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_DOCUMENT_NOT_FOUND" },
    });
  });

  it("bắt buộc có ít nhất một kênh chính thức", async () => {
    const body = validBody();
    body.channels = [];

    await expect(
      organizationApplicationService.createApplication(EMAIL, "sub-token", body),
    ).rejects.toMatchObject({ statusResponse: { status: 400 } });
  });

  it("không có ô đồng ý xử lý dữ liệu cá nhân thì không nhận hồ sơ", async () => {
    const body = { ...validBody(), consent: false };

    await expect(
      organizationApplicationService.createApplication(EMAIL, "sub-token", body),
    ).rejects.toMatchObject({ statusResponse: { status: 400 } });
  });
});

describe("OrganizationApplicationService.presignDocument", () => {
  beforeEach(() => {
    countUnattachedDocumentsMock.mockResolvedValue(0);
    createSignedUploadMock.mockReturnValue({
      uploadUrl: "https://api.cloudinary.com/v1_1/demo/image/upload",
      fields: { signature: "sig" },
      storageKey: "folder/public-id",
      expiresAt: new Date().toISOString(),
    });
    createDocumentMock.mockResolvedValue({ id: "doc-1" });
  });

  it("chỉ nhận pdf / jpg / png", async () => {
    await expect(
      organizationApplicationService.presignDocument(EMAIL, {
        docType: "BUSINESS_LICENSE",
        fileName: "a.docx",
        mimeType: "application/msword",
        sizeBytes: 1000,
      }),
    ).rejects.toMatchObject({ statusResponse: { status: 400 } });
  });

  it("chặn file quá 10 MB", async () => {
    await expect(
      organizationApplicationService.presignDocument(EMAIL, {
        docType: "BUSINESS_LICENSE",
        fileName: "a.pdf",
        mimeType: "application/pdf",
        sizeBytes: 11 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ statusResponse: { status: 400 } });
  });

  it("chặn khi đã có 5 file chưa gắn hồ sơ", async () => {
    countUnattachedDocumentsMock.mockResolvedValue(5);

    await expect(
      organizationApplicationService.presignDocument(EMAIL, {
        docType: "BUSINESS_LICENSE",
        fileName: "a.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1000,
      }),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_DOCUMENT_LIMIT" },
    });
  });

  it("lưu storage key và format suy ra từ mime type", async () => {
    const result = await organizationApplicationService.presignDocument(EMAIL, {
      docType: "BUSINESS_LICENSE",
      fileName: "giay-phep.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
    });

    expect(createDocumentMock.mock.calls[0][0]).toMatchObject({
      submissionEmail: EMAIL,
      format: "pdf",
      storageKey: "folder/public-id",
    });
    expect(result.documentId).toBe("doc-1");
  });
});
