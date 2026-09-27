/**
 * Owner changes (phase 3): ADD_OWNER / REMOVE_OWNER được quyết trong tổ
 * chức — người liên quan xác nhận qua email, các owner còn lại đồng ý — không qua admin.
 * Chạy trên một Prisma giả trong bộ nhớ (helpers/owner-change-fake-db) để đi hết đường
 * create → approve → executor áp dụng membership.
 */

const mockAssertOwnersEligible = jest.fn();
const mockResendCandidate = jest.fn();
const mockLookupUsersByIds = jest.fn();
const mockLookupUsersByEmails = jest.fn();
const mockEnsureUsers = jest.fn();
const mockSendConfirmationEmails = jest.fn();
const mockNotifyApprovalRequested = jest.fn();
const mockNotifyRemovalProposed = jest.fn();
const mockNotifyDecided = jest.fn();
const mockMembershipChanged = jest.fn();
const mockEmitOutbox = jest.fn();

jest.mock("../../../config/prisma.client", () => ({
  __esModule: true,
  default: jest.requireActual("./helpers/owner-change-fake-db").fakePrisma,
}));
jest.mock("../../organization/organization_member.repository", () => ({
  organizationMemberRepository: jest.requireActual("./helpers/owner-change-fake-db")
    .fakeMemberRepository,
}));
jest.mock("../../organization/organization-membership.service", () => ({
  ...jest.requireActual("../../organization/organization-membership.service"),
  organizationMembershipService: jest.requireActual("./helpers/owner-change-fake-db")
    .fakeMembershipService,
}));
jest.mock("../../organization/organization.repository", () => {
  const h = jest.requireActual("./helpers/owner-change-fake-db");
  return {
    organizationRepository: {
      findById: async (id: string) =>
        h.fakeStore.organizations.find((o: { id: string }) => o.id === id) ?? null,
    },
  };
});
jest.mock("../organization-application.repository", () => ({
  organizationApplicationRepository: jest.requireActual("./helpers/owner-change-fake-db")
    .fakeApplicationRepository,
}));
jest.mock("../organization-application.service", () => ({
  organizationApplicationService: {
    createWithUniqueCode: (d: unknown) =>
      jest.requireActual("./helpers/owner-change-fake-db").fakeCreateWithUniqueCode(d),
    assertOwnersEligible: (...a: unknown[]) => mockAssertOwnersEligible(...a),
    resendCandidate: (...a: unknown[]) => mockResendCandidate(...a),
  },
}));
jest.mock("../identity-owner.client", () => ({
  IdentityUserStatus: jest.requireActual("../identity-owner.client").IdentityUserStatus,
  lookupUsersByIds: (...a: unknown[]) => mockLookupUsersByIds(...a),
  lookupUsersByEmails: (...a: unknown[]) => mockLookupUsersByEmails(...a),
  ensureUsers: (...a: unknown[]) => mockEnsureUsers(...a),
}));
jest.mock("../owner-candidates", () => ({
  ...jest.requireActual("../owner-candidates"),
  sendConfirmationEmails: (...a: unknown[]) => mockSendConfirmationEmails(...a),
}));
jest.mock("../owner-change-notify.client", () => ({
  notifyApprovalRequested: (...a: unknown[]) => mockNotifyApprovalRequested(...a),
  notifyRemovalProposed: (...a: unknown[]) => mockNotifyRemovalProposed(...a),
  notifyDecided: (...a: unknown[]) => mockNotifyDecided(...a),
  notifyOwnerLeft: jest.fn(),
}));
jest.mock("../organization-application-notify.client", () => ({
  enqueueApplicationWithdrawnNoticeEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../organization/organization-member-notify.client", () => ({
  enqueueOrgMembershipChangedWebsiteNotification: (...a: unknown[]) =>
    mockMembershipChanged(...a),
}));
jest.mock("../../../outbox/outbox.writer", () => ({
  emitOutbox: (...a: unknown[]) => mockEmitOutbox(...a),
}));

import {
  activeRole,
  addMember,
  addOrg,
  fakeStore,
  resetFakeStore,
} from "./helpers/owner-change-fake-db";
import { ownerChangeService } from "../owner-change.service";
import { ownerChangeExecutor } from "../owner-change-executor";

const ORG = "org-1";
type User = { id: string; email: string; name: string; status: number };
const USERS: Record<string, User> = {
  "u-an": { id: "u-an", email: "an@clb.vn", name: "An", status: 1 },
  "u-binh": { id: "u-binh", email: "binh@clb.vn", name: "Binh", status: 1 },
  "u-chi": { id: "u-chi", email: "chi@clb.vn", name: "Chi", status: 1 },
  "u-dung": { id: "u-dung", email: "dung@clb.vn", name: "Dung", status: 1 },
};

function setupIdentity() {
  mockLookupUsersByIds.mockImplementation(async (ids: string[]) =>
    new Map(ids.filter((id) => USERS[id]).map((id) => [id, USERS[id]])),
  );
  mockLookupUsersByEmails.mockImplementation(async (emails: string[]) => {
    const all = Object.values(USERS);
    return new Map(
      emails
        .map((e) => all.find((u) => u.email === e))
        .filter((u): u is User => Boolean(u))
        .map((u) => [u.email, u]),
    );
  });
  mockEnsureUsers.mockImplementation(async (people: { email: string; fullName: string }[]) => {
    const all = Object.values(USERS);
    return new Map(
      people.map((p) => [
        p.email,
        all.find((u) => u.email === p.email) ?? {
          id: `u-new-${p.email}`,
          email: p.email,
          name: p.fullName,
          status: 1,
        },
      ]),
    );
  });
}

/** Every candidate clicks "confirm" (the confirmation service is tested on its own). */
async function confirmCandidates(applicationId: string) {
  fakeStore.candidates
    .filter((c) => c.applicationId === applicationId)
    .forEach((c) => {
      c.status = "CONFIRMED";
    });
  return ownerChangeExecutor.tryFinalize(applicationId);
}

const statusOf = (id: string) => fakeStore.applications.find((a) => a.id === id)?.status;
const approvalsOf = (id: string) =>
  fakeStore.approvals.filter((a) => a.applicationId === id).map((a) => a.approverUserId);

beforeEach(() => {
  jest.clearAllMocks();
  resetFakeStore();
  addOrg(fakeStore, ORG);
  setupIdentity();
  mockAssertOwnersEligible.mockResolvedValue(undefined);
  mockEmitOutbox.mockResolvedValue(undefined);
  mockMembershipChanged.mockResolvedValue(undefined);
});

const code = (c: string) => ({ statusResponse: { code: c } });

describe("ADD_OWNER", () => {
  it("tổ chức một owner: chỉ cần người được đề xuất xác nhận là thành owner, không qua admin", async () => {
    addMember(fakeStore, "u-an", "OWNER");

    const change = await ownerChangeService.create(ORG, "u-an", "An@Clb.vn", {
      type: "ADD_OWNER",
      owners: [{ email: "Moi@Gmail.com", fullName: "Nguoi Moi" }],
      reason: "Mở rộng ban điều hành",
    });

    expect(change).toMatchObject({
      type: "ADD_OWNER",
      status: "AWAITING_OWNER_CONFIRMATION",
      reason: "Mở rộng ban điều hành",
      approvals: [],
      canCancel: true,
    });
    expect(change.owners[0]).toMatchObject({ email: "moi@gmail.com", status: "PENDING" });
    expect(mockSendConfirmationEmails.mock.calls[0][0]).toMatchObject({
      isAddOwner: true,
    });
    const app = fakeStore.applications[0];
    expect(app).toMatchObject({ organizationId: ORG, submittedByUserId: "u-an" });
    expect(app.organization).toBeUndefined();

    await expect(confirmCandidates(change.id)).resolves.toBe("APPROVED");
    expect(activeRole(fakeStore, "u-new-moi@gmail.com")).toBe("OWNER");
    expect(mockEmitOutbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "ORG_OWNER_ONBOARD" }),
    );
    expect(mockNotifyDecided).toHaveBeenCalledWith(
      expect.arrayContaining(["u-an"]),
      expect.objectContaining({ outcome: "approved" }),
    );
  });

  it("ba owner: cần hai owner còn lại đồng ý, thiếu một người thì chưa áp dụng", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    addMember(fakeStore, "u-chi", "LEGAL_REPRESENTATIVE");
    addMember(fakeStore, "u-dung", "MEMBER");

    const change = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "ADD_OWNER",
      owners: [{ userId: "u-dung", fullName: "" }],
    });
    expect(approvalsOf(change.id).sort()).toEqual(["u-binh", "u-chi"]);
    expect(mockNotifyApprovalRequested.mock.calls[0][0].sort()).toEqual(["u-binh", "u-chi"]);

    await expect(confirmCandidates(change.id)).resolves.toBe("AWAITING_OWNER_CONFIRMATION");
    await ownerChangeService.approve(ORG, change.id, "u-binh");
    expect(statusOf(change.id)).toBe("AWAITING_OWNER_CONFIRMATION");
    expect(activeRole(fakeStore, "u-dung")).toBe("MEMBER");

    await ownerChangeService.approve(ORG, change.id, "u-chi");
    expect(statusOf(change.id)).toBe("APPROVED");
    // MEMBER được nâng tại chỗ, không tạo dòng mới.
    expect(activeRole(fakeStore, "u-dung")).toBe("OWNER");
    expect(fakeStore.members.filter((m) => m.userId === "u-dung")).toHaveLength(1);
  });

  it("một owner từ chối → REJECTED với lý do, link đang chờ hết hiệu lực, không ai đồng ý thêm được", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    addMember(fakeStore, "u-chi", "OWNER");

    const change = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "ADD_OWNER",
      owners: [{ email: "moi@gmail.com", fullName: "Moi" }],
    });
    await ownerChangeService.reject(ORG, change.id, "u-chi", "  Không quen người này ");

    const app = fakeStore.applications.find((a) => a.id === change.id)!;
    expect(app).toMatchObject({ status: "REJECTED", rejectReason: "Không quen người này" });
    expect(fakeStore.candidates[0].expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(mockNotifyDecided).toHaveBeenCalledWith(
      ["u-an"],
      expect.objectContaining({ outcome: "rejected", reason: "Không quen người này" }),
    );
    await expect(ownerChangeService.approve(ORG, change.id, "u-binh")).rejects.toMatchObject(
      code("OWNER_CHANGE_NOT_OPEN"),
    );
  });

  it("người đề xuất không tự duyệt được; người không phải owner bị chặn", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    addMember(fakeStore, "u-dung", "ADMIN");
    const change = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "ADD_OWNER",
      owners: [{ email: "moi@gmail.com", fullName: "Moi" }],
    });

    await expect(ownerChangeService.approve(ORG, change.id, "u-an")).rejects.toMatchObject(
      code("NOT_PENDING_APPROVER"),
    );
    await expect(ownerChangeService.approve(ORG, change.id, "u-dung")).rejects.toMatchObject(
      code("ORG_PERMISSION_DENIED"),
    );
    await expect(
      ownerChangeService.reject(ORG, change.id, "u-dung", null),
    ).rejects.toMatchObject(code("ORG_PERMISSION_DENIED"));
  });

  it("đã có đề xuất thêm owner đang mở → OWNER_CHANGE_ALREADY_OPEN", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "ADD_OWNER",
      owners: [{ email: "moi@gmail.com", fullName: "Moi" }],
    });
    await expect(
      ownerChangeService.create(ORG, "u-binh", "binh@clb.vn", {
        type: "ADD_OWNER",
        owners: [{ email: "khac@gmail.com", fullName: "Khac" }],
      }),
    ).rejects.toMatchObject(code("OWNER_CHANGE_ALREADY_OPEN"));
  });

  it("người được đề xuất đã là owner → ALREADY_OWNER", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    await expect(
      ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
        type: "ADD_OWNER",
        owners: [{ email: "binh@clb.vn", fullName: "Binh" }],
      }),
    ).rejects.toMatchObject(code("ALREADY_OWNER"));
    expect(fakeStore.applications).toHaveLength(0);
  });
});

describe("REMOVE_OWNER", () => {
  it("chỉ hai owner: không còn ai để hỏi → có hiệu lực ngay khi tạo; không chỉ định vai → người bị thu hồi thành MEMBER", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");

    const change = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "REMOVE_OWNER",
      targetUserId: "u-binh",
      reason: "Không còn hoạt động",
    });

    expect(change.status).toBe("APPROVED");
    expect(activeRole(fakeStore, "u-binh")).toBe("MEMBER");
    expect(mockNotifyRemovalProposed).toHaveBeenCalledWith(
      "u-binh",
      expect.objectContaining({ needsApproval: false, subjectNames: "Binh" }),
    );
    expect(mockMembershipChanged).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-binh", role: "MEMBER" }),
    );
  });

  it("ba owner: chờ owner thứ ba đồng ý; demoteTo ADMIN giữ người đó lại với vai ADMIN", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    addMember(fakeStore, "u-chi", "OWNER");

    const change = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "REMOVE_OWNER",
      targetUserId: "u-chi",
      demoteTo: "ADMIN",
    });
    expect(change.status).toBe("AWAITING_OWNER_CONFIRMATION");
    expect(approvalsOf(change.id)).toEqual(["u-binh"]);
    expect(activeRole(fakeStore, "u-chi")).toBe("OWNER");
    // Người bị thu hồi không được hỏi ý kiến.
    await expect(ownerChangeService.approve(ORG, change.id, "u-chi")).rejects.toMatchObject(
      code("NOT_PENDING_APPROVER"),
    );

    await ownerChangeService.approve(ORG, change.id, "u-binh");
    expect(statusOf(change.id)).toBe("APPROVED");
    expect(activeRole(fakeStore, "u-chi")).toBe("ADMIN");
    expect(mockMembershipChanged).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-chi", role: "ADMIN" }),
    );
  });

  it("tự thu hồi mình → CANNOT_TARGET_SELF; target không phải owner → TARGET_NOT_OWNER", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    addMember(fakeStore, "u-dung", "MEMBER");

    await expect(
      ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
        type: "REMOVE_OWNER",
        targetUserId: "u-an",
      }),
    ).rejects.toMatchObject(code("CANNOT_TARGET_SELF"));
    await expect(
      ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
        type: "REMOVE_OWNER",
        targetUserId: "u-dung",
      }),
    ).rejects.toMatchObject(code("TARGET_NOT_OWNER"));
  });

  it("đã có đề xuất thu hồi cùng người đang mở → OWNER_CHANGE_ALREADY_OPEN", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    addMember(fakeStore, "u-chi", "OWNER");
    await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "REMOVE_OWNER",
      targetUserId: "u-chi",
    });
    await expect(
      ownerChangeService.create(ORG, "u-binh", "binh@clb.vn", {
        type: "REMOVE_OWNER",
        targetUserId: "u-chi",
      }),
    ).rejects.toMatchObject(code("OWNER_CHANGE_ALREADY_OPEN"));
  });

  it("demoteTo ngoài ADMIN/MEMBER → VALIDATION_ERROR", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    await expect(
      ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
        type: "REMOVE_OWNER",
        targetUserId: "u-binh",
        demoteTo: "OWNER",
      }),
    ).rejects.toMatchObject(code("VALIDATION_ERROR"));
  });
});

describe("REMOVE_OWNER — người đại diện pháp lý cần người thay", () => {
  it("thu hồi LR mà không có người thay → LEGAL_REP_REPLACEMENT_REQUIRED", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "LEGAL_REPRESENTATIVE");
    await expect(
      ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
        type: "REMOVE_OWNER",
        targetUserId: "u-binh",
      }),
    ).rejects.toMatchObject({ statusResponse: { code: "LEGAL_REP_REPLACEMENT_REQUIRED" } });
  });

  it("người thay chỉ dành cho LR → VALIDATION_ERROR với owner thường", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    await expect(
      ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
        type: "REMOVE_OWNER",
        targetUserId: "u-binh",
        replacement: { userId: "u-chi", fullName: "Chi" },
      }),
    ).rejects.toMatchObject({ statusResponse: { code: "VALIDATION_ERROR" } });
  });

  it("LR tự hạ vai, người thay là owner có sẵn: owner đó không phải duyệt; xác nhận → thành LR, LR cũ thành MEMBER", async () => {
    addMember(fakeStore, "u-an", "LEGAL_REPRESENTATIVE");
    addMember(fakeStore, "u-binh", "OWNER");
    addMember(fakeStore, "u-chi", "OWNER");

    const change = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "REMOVE_OWNER",
      targetUserId: "u-an",
      replacement: { userId: "u-binh", fullName: "Binh" },
    });
    expect(change.status).toBe("AWAITING_OWNER_CONFIRMATION");
    expect(change.owners).toEqual([
      expect.objectContaining({ email: "binh@clb.vn", isLegalRep: true, status: "PENDING" }),
    ]);
    expect(change.approvals.map((a) => a.userId)).toEqual(["u-chi"]);
    expect(mockSendConfirmationEmails.mock.calls[0][0]).toMatchObject({ isAddOwner: true });

    await confirmCandidates(change.id);
    fakeStore.approvals.forEach((a) => (a.status = "APPROVED"));
    await expect(ownerChangeExecutor.tryFinalize(change.id)).resolves.toBe("APPROVED");
    expect(activeRole(fakeStore, "u-binh")).toBe("LEGAL_REPRESENTATIVE");
    expect(activeRole(fakeStore, "u-an")).toBe("MEMBER");
  });

  it("người thay là email mới: tạo tài khoản lúc áp dụng, thành LR", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "LEGAL_REPRESENTATIVE");

    const change = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "REMOVE_OWNER",
      targetUserId: "u-binh",
      replacement: { email: "moi@gmail.com", fullName: "Nguoi Moi" },
    });
    // Two owners: nobody else to ask, only the replacement's confirmation.
    expect(change.approvals).toEqual([]);
    expect(change.status).toBe("AWAITING_OWNER_CONFIRMATION");

    await confirmCandidates(change.id);
    await expect(ownerChangeExecutor.tryFinalize(change.id)).resolves.toBe("APPROVED");
    expect(activeRole(fakeStore, "u-new-moi@gmail.com")).toBe("LEGAL_REPRESENTATIVE");
    expect(activeRole(fakeStore, "u-binh")).toBe("MEMBER");
  });

  it("owner thường vẫn không tự nhắm mình được", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    await expect(
      ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
        type: "REMOVE_OWNER",
        targetUserId: "u-an",
      }),
    ).rejects.toMatchObject({ statusResponse: { code: "CANNOT_TARGET_SELF" } });
  });
});

describe("cancel / list", () => {
  it("chỉ người đề xuất huỷ được; huỷ → WITHDRAWN và báo cho người liên quan", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    addMember(fakeStore, "u-chi", "OWNER");
    const change = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "REMOVE_OWNER",
      targetUserId: "u-chi",
    });

    await expect(ownerChangeService.cancel(ORG, change.id, "u-binh")).rejects.toMatchObject(
      code("ORG_PERMISSION_DENIED"),
    );
    await ownerChangeService.cancel(ORG, change.id, "u-an");
    expect(statusOf(change.id)).toBe("WITHDRAWN");
    expect(mockNotifyDecided).toHaveBeenCalledWith(
      ["u-chi"],
      expect.objectContaining({ outcome: "withdrawn" }),
    );
    await expect(ownerChangeService.cancel(ORG, change.id, "u-an")).rejects.toMatchObject(
      code("OWNER_CHANGE_NOT_OPEN"),
    );
  });

  it("list: trả người đề xuất, target, từng approver kèm myApproval và canCancel theo người xem", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    addMember(fakeStore, "u-chi", "OWNER");
    const created = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "REMOVE_OWNER",
      targetUserId: "u-chi",
      demoteTo: "MEMBER",
    });

    const [seen] = await ownerChangeService.list(ORG, "u-binh");
    expect(seen).toMatchObject({
      id: created.id,
      proposer: { userId: "u-an", name: "An", email: "an@clb.vn" },
      target: { userId: "u-chi", name: "Chi" },
      demoteTo: "MEMBER",
      myApproval: "PENDING",
      canCancel: false,
      approvals: [expect.objectContaining({ userId: "u-binh", status: "PENDING", void: false })],
    });
    const [own] = await ownerChangeService.list(ORG, "u-an");
    expect(own).toMatchObject({ myApproval: null, canCancel: true });
  });

  it("resend: đi qua resendCandidate chung sau khi kiểm đề xuất thuộc tổ chức", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    const change = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "ADD_OWNER",
      owners: [{ email: "moi@gmail.com", fullName: "Moi" }],
    });
    await ownerChangeService.resend(ORG, change.id, change.owners[0].id, "u-an");
    expect(mockResendCandidate).toHaveBeenCalledWith(change.id, change.owners[0].id);
    await expect(
      ownerChangeService.resend("org-khac", change.id, change.owners[0].id, "u-an"),
    ).rejects.toMatchObject(code("ORG_PERMISSION_DENIED"));
  });
});
