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
const findByIdMock = jest.fn();
const findByIdWithRelationsMock = jest.fn();
const softDeleteDocumentMock = jest.fn();
const updateMock = jest.fn();
const resolveTrackingTokenMock = jest.fn();
const findDocumentByIdMock = jest.fn();
const downloadMock = jest.fn();

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
    findById: (...a: unknown[]) => findByIdMock(...a),
    findByIdWithRelations: (...a: unknown[]) => findByIdWithRelationsMock(...a),
    softDeleteDocument: (...a: unknown[]) => softDeleteDocumentMock(...a),
    update: (...a: unknown[]) => updateMock(...a),
    findDocumentById: (...a: unknown[]) => findDocumentByIdMock(...a),
  },
}));

jest.mock("../organization-application-otp.service", () => ({
  organizationApplicationOtpService: {
    consumeSubmissionToken: (...a: unknown[]) => consumeSubmissionTokenMock(...a),
    issueTrackingToken: (...a: unknown[]) => issueTrackingTokenMock(...a),
    resolveTrackingToken: (...a: unknown[]) => resolveTrackingTokenMock(...a),
  },
}));

jest.mock("../organization-application-notify.client", () => ({
  enqueueApplicationReceivedEmail: (...a: unknown[]) => receivedEmailMock(...a),
}));

jest.mock("../storage/cloudinary-document-storage", () => ({
  documentStorage: {
    createSignedUpload: (...a: unknown[]) => createSignedUploadMock(...a),
    download: (...a: unknown[]) => downloadMock(...a),
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

describe("OrganizationApplicationService.updateApplication", () => {
  const application = (status = "NEEDS_MORE_INFO") => ({
    id: "app-1",
    code: "ORG-1",
    orgType: "CLUB",
    status,
    contactEmail: EMAIL,
    profile: {},
    channels: [],
    reviewNote: "Thiếu giấy tờ",
    rejectReason: null,
    organizationId: null,
    createdAt: new Date(),
    reviewedAt: null,
  });
  const attached = (ids: string[]) =>
    ids.map((id) => ({ id, submissionEmail: EMAIL, applicationId: "app-1" }));

  beforeEach(() => {
    jest.clearAllMocks();
    resolveTrackingTokenMock.mockResolvedValue(EMAIL);
    findByIdMock.mockResolvedValue(application());
    findByIdWithRelationsMock.mockResolvedValue({
      ...application(),
      documents: attached(["doc-1", "doc-2"]),
    });
    findDocumentsByIdsMock.mockResolvedValue([]);
    softDeleteDocumentMock.mockResolvedValue(undefined);
    attachDocumentsMock.mockResolvedValue(undefined);
    updateMock.mockResolvedValue(undefined);
    recordEventMock.mockResolvedValue(undefined);
  });

  it("gỡ giấy tờ cũ của chính hồ sơ khi nộp lại", async () => {
    await organizationApplicationService.updateApplication("app-1", "track", {
      removeDocumentIds: ["doc-1"],
    });

    expect(softDeleteDocumentMock).toHaveBeenCalledWith("doc-1");
    expect(updateMock).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({ status: "SUBMITTED" }),
    );
  });

  it("ghi lại tên các trường người nộp đã sửa, không ghi giá trị", async () => {
    findByIdMock.mockResolvedValue({
      ...application(),
      profile: {
        name: "Tên cũ",
        contactEmail: EMAIL,
        logoUrl: "https://res.cloudinary.com/demo/logo.png",
      },
      channels: [{ type: "FACEBOOK_PAGE", url: "https://facebook.com/old", isPrimary: true }],
    });

    await organizationApplicationService.updateApplication("app-1", "track", {
      orgType: "CLUB",
      profile: {
        name: "Tên mới",
        contactEmail: EMAIL,
        logoUrl: "https://res.cloudinary.com/demo/logo.png",
      },
      channels: [{ type: "FACEBOOK_PAGE", url: "https://facebook.com/new", isPrimary: true }],
    });

    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "RESUBMITTED",
        payload: expect.objectContaining({
          changedFields: ["profile.name", "channels"],
        }),
      }),
    );
  });

  it("không cho gỡ giấy tờ không thuộc hồ sơ, và không ghi gì cả", async () => {
    await expect(
      organizationApplicationService.updateApplication("app-1", "track", {
        removeDocumentIds: ["doc-of-someone-else"],
      }),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_DOCUMENT_NOT_FOUND" },
    });
    expect(softDeleteDocumentMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("chặn khi tổng số giấy tờ sau khi nộp lại vượt hạn mức", async () => {
    findByIdWithRelationsMock.mockResolvedValue({
      ...application(),
      documents: attached(["d1", "d2", "d3", "d4"]),
    });
    findDocumentsByIdsMock.mockResolvedValue([
      { id: "n1", submissionEmail: EMAIL },
      { id: "n2", submissionEmail: EMAIL },
    ]);

    await expect(
      organizationApplicationService.updateApplication("app-1", "track", {
        documentIds: ["n1", "n2"],
      }),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_DOCUMENT_LIMIT" },
    });
    expect(attachDocumentsMock).not.toHaveBeenCalled();
  });

  it("chỉ sửa được khi admin đang yêu cầu bổ sung", async () => {
    findByIdMock.mockResolvedValue(application("SUBMITTED"));

    await expect(
      organizationApplicationService.updateApplication("app-1", "track", {}),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_NOT_EDITABLE" },
    });
  });

  it("upload giấy tờ bằng link tra cứu chỉ khi đang cần bổ sung", async () => {
    findByIdMock.mockResolvedValue(application("UNDER_REVIEW"));

    await expect(
      organizationApplicationService.presignDocumentForApplication(
        "app-1",
        "track",
        {
          docType: "OTHER",
          fileName: "a.pdf",
          mimeType: "application/pdf",
          sizeBytes: 100,
        },
      ),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_APPLICATION_NOT_EDITABLE" },
    });
    expect(createSignedUploadMock).not.toHaveBeenCalled();
  });
});

describe("OrganizationApplicationService.openDocumentForApplicant", () => {
  const doc = (overrides: Record<string, unknown> = {}) => ({
    id: "doc-1",
    applicationId: "app-1",
    docType: "BUSINESS_LICENSE",
    storageKey: "key",
    format: "pdf",
    fileName: "giay-phep.pdf",
    purgedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resolveTrackingTokenMock.mockResolvedValue(EMAIL);
    findByIdMock.mockResolvedValue({ id: "app-1", contactEmail: EMAIL });
    findDocumentByIdMock.mockResolvedValue(doc());
    downloadMock.mockResolvedValue({
      stream: {},
      contentType: "application/pdf",
    });
    recordEventMock.mockResolvedValue(undefined);
  });

  it("mở được giấy tờ của chính hồ sơ và ghi lại lượt xem không có actor", async () => {
    const file = await organizationApplicationService.openDocumentForApplicant(
      "app-1",
      "track",
      "doc-1",
    );

    expect(file.fileName).toBe("giay-phep.pdf");
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "DOCUMENT_VIEWED",
        actorId: null,
        payload: expect.objectContaining({ viewer: "applicant" }),
      }),
    );
  });

  it("không mở được giấy tờ thuộc hồ sơ khác", async () => {
    findDocumentByIdMock.mockResolvedValue(doc({ applicationId: "app-2" }));

    await expect(
      organizationApplicationService.openDocumentForApplicant("app-1", "track", "doc-1"),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_DOCUMENT_NOT_FOUND" },
    });
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("giấy tờ đã bị xoá theo chính sách lưu trữ thì trả 404", async () => {
    findDocumentByIdMock.mockResolvedValue(doc({ purgedAt: new Date() }));

    await expect(
      organizationApplicationService.openDocumentForApplicant("app-1", "track", "doc-1"),
    ).rejects.toMatchObject({
      statusResponse: { code: "ORGANIZATION_DOCUMENT_NOT_FOUND" },
    });
    expect(recordEventMock).not.toHaveBeenCalled();
  });
});
