/**
 * OwnerChangeExecutor: áp dụng owner change khi đủ điều kiện, huỷ những đề xuất không còn
 * hợp lệ sau mỗi lần vai owner thay đổi, và sweeper mỗi giờ (approval quá hạn, thử lại sau
 * lỗi tạm thời). Prisma giả trong bộ nhớ, transaction có rollback.
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
  fakePrisma,
  resetFakeStore,
} from "./helpers/owner-change-fake-db";
import { ownerChangeService } from "../owner-change.service";
import { isOwnerChangeReady, ownerChangeExecutor } from "../owner-change-executor";

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

const appOf = (id: string) => fakeStore.applications.find((a) => a.id === id)!;
const DAY = 24 * 60 * 60 * 1000;

async function threeOwnersAddDung() {
  addMember(fakeStore, "u-an", "OWNER");
  addMember(fakeStore, "u-binh", "OWNER");
  addMember(fakeStore, "u-chi", "OWNER");
  addMember(fakeStore, "u-dung", "MEMBER");
  return ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
    type: "ADD_OWNER",
    owners: [{ userId: "u-dung", fullName: "" }],
  });
}

describe("isOwnerChangeReady", () => {
  const base = {
    type: "REMOVE_OWNER",
    status: "AWAITING_OWNER_CONFIRMATION",
    owners: [],
    approvals: [{ approverUserId: "u-b", status: "PENDING" }],
  } as never;

  it("approver còn là owner mà chưa trả lời → chưa sẵn sàng; đã rời → không còn tính", () => {
    expect(isOwnerChangeReady(base, new Set(["u-a", "u-b"]))).toBe(false);
    expect(isOwnerChangeReady(base, new Set(["u-a"]))).toBe(true);
  });

  it("ADD_OWNER cần ít nhất một candidate và tất cả đã xác nhận", () => {
    const add = { ...(base as object), type: "ADD_OWNER", approvals: [] } as never;
    expect(isOwnerChangeReady(add, new Set())).toBe(false);
    const pending = {
      ...(add as object),
      owners: [{ status: "CONFIRMED" }, { status: "PENDING" }],
    } as never;
    expect(isOwnerChangeReady(pending, new Set())).toBe(false);
  });
});

describe("reconcileOpenChanges", () => {
  it("approver cuối cùng rời tổ chức → đề xuất tự được áp dụng", async () => {
    const change = await threeOwnersAddDung();
    fakeStore.candidates.forEach((c) => (c.status = "CONFIRMED"));
    await ownerChangeService.approve(ORG, change.id, "u-binh");
    expect(appOf(change.id).status).toBe("AWAITING_OWNER_CONFIRMATION");

    fakeStore.members.find((m) => m.userId === "u-chi")!.deletedAt = new Date();
    await ownerChangeExecutor.reconcileOpenChanges(ORG);

    expect(appOf(change.id).status).toBe("APPROVED");
    expect(activeRole(fakeStore, "u-dung")).toBe("OWNER");
  });

  it("người đề xuất không còn là owner → WITHDRAWN kèm lý do", async () => {
    const change = await threeOwnersAddDung();
    fakeStore.members.find((m) => m.userId === "u-an")!.role = "ADMIN";

    await ownerChangeExecutor.reconcileOpenChanges(ORG);

    expect(appOf(change.id)).toMatchObject({
      status: "WITHDRAWN",
      reviewNote: "Người đề xuất không còn là owner.",
    });
    expect(mockNotifyDecided).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ outcome: "withdrawn" }),
    );
  });

  it("thu hồi người đã không còn là owner → WITHDRAWN", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    addMember(fakeStore, "u-chi", "OWNER");
    const change = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "REMOVE_OWNER",
      targetUserId: "u-chi",
    });
    fakeStore.members.find((m) => m.userId === "u-chi")!.deletedAt = new Date();

    await ownerChangeExecutor.reconcileOpenChanges(ORG);
    expect(appOf(change.id)).toMatchObject({
      status: "WITHDRAWN",
      reviewNote: "Người bị đề xuất thu hồi không còn là owner.",
    });
  });

});

describe("tryFinalize", () => {
  it("người đề xuất mất vai owner ngay lúc áp dụng (đọc dưới lock) → REJECTED, không đổi membership", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    addMember(fakeStore, "u-chi", "OWNER");
    const change = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "REMOVE_OWNER",
      targetUserId: "u-chi",
    });
    // Binh đã đồng ý; ngay trước khi áp dụng, người đề xuất tự hạ vai (reconcile chưa kịp chạy).
    fakeStore.approvals.forEach((a) => (a.status = "APPROVED"));
    fakeStore.members.find((m) => m.userId === "u-an")!.role = "MEMBER";

    await expect(ownerChangeExecutor.tryFinalize(change.id)).resolves.toBe("REJECTED");
    expect(appOf(change.id).rejectReason).toBe("Người đề xuất không còn là owner.");
    expect(activeRole(fakeStore, "u-chi")).toBe("OWNER");
  });

  it("identity lỗi tạm thời khi tạo tài khoản → giữ nguyên trạng thái, lần sau áp dụng được", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    const change = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "ADD_OWNER",
      owners: [{ email: "moi@gmail.com", fullName: "Moi" }],
    });
    fakeStore.candidates.forEach((c) => (c.status = "CONFIRMED"));
    mockEnsureUsers.mockRejectedValueOnce(new Error("identity down"));

    await expect(ownerChangeExecutor.tryFinalize(change.id)).resolves.toBe(
      "AWAITING_OWNER_CONFIRMATION",
    );
    expect(activeRole(fakeStore, "u-new-moi@gmail.com")).toBeNull();

    await expect(ownerChangeExecutor.tryFinalize(change.id)).resolves.toBe("APPROVED");
    expect(activeRole(fakeStore, "u-new-moi@gmail.com")).toBe("OWNER");
  });

  it("lỗi DB tạm thời khi hạ vai người bị thu hồi → rollback, giữ trạng thái, lần sau áp dụng được", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    addMember(fakeStore, "u-binh", "OWNER");
    addMember(fakeStore, "u-chi", "OWNER");
    const change = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "REMOVE_OWNER",
      targetUserId: "u-chi",
      demoteTo: "MEMBER",
    });
    fakeStore.approvals.forEach((a) => (a.status = "APPROVED"));
    const original = fakePrisma.organizationMember.update;
    fakePrisma.organizationMember.update = async () => {
      throw new Error("connection reset");
    };
    try {
      await expect(ownerChangeExecutor.tryFinalize(change.id)).resolves.toBe(
        "AWAITING_OWNER_CONFIRMATION",
      );
    } finally {
      fakePrisma.organizationMember.update = original;
    }
    expect(activeRole(fakeStore, "u-chi")).toBe("OWNER");
    expect(appOf(change.id).status).toBe("AWAITING_OWNER_CONFIRMATION");

    await expect(ownerChangeExecutor.tryFinalize(change.id)).resolves.toBe("APPROVED");
    expect(activeRole(fakeStore, "u-chi")).toBe("MEMBER");
  });

  it("đề xuất đã đóng → không làm gì", async () => {
    const change = await threeOwnersAddDung();
    appOf(change.id).status = "WITHDRAWN";
    await expect(ownerChangeExecutor.tryFinalize(change.id)).resolves.toBe("WITHDRAWN");
    expect(mockEnsureUsers).not.toHaveBeenCalled();
  });
});

describe("sweep", () => {
  it("owner được hỏi không trả lời kịp 14 ngày → approval EXPIRED, đề xuất WITHDRAWN", async () => {
    const change = await threeOwnersAddDung();
    fakeStore.approvals
      .filter((a) => a.approverUserId === "u-chi")
      .forEach((a) => (a.expiresAt = new Date(Date.now() - DAY)));

    await expect(ownerChangeExecutor.sweep()).resolves.toEqual({ expired: 1, applied: 0 });
    expect(appOf(change.id).status).toBe("WITHDRAWN");
    expect(fakeStore.approvals.find((a) => a.approverUserId === "u-chi")!.status).toBe(
      "EXPIRED",
    );
  });

  it("approval quá hạn của người đã không còn là owner không làm huỷ đề xuất", async () => {
    const change = await threeOwnersAddDung();
    fakeStore.candidates.forEach((c) => (c.status = "CONFIRMED"));
    fakeStore.approvals.forEach((a) => (a.expiresAt = new Date(Date.now() - DAY)));
    fakeStore.members
      .filter((m) => m.userId === "u-binh" || m.userId === "u-chi")
      .forEach((m) => (m.deletedAt = new Date()));

    await expect(ownerChangeExecutor.sweep()).resolves.toEqual({ expired: 0, applied: 1 });
    expect(appOf(change.id).status).toBe("APPROVED");
  });

  it("đề xuất đã đủ điều kiện nhưng lần trước lỗi tạm thời → sweeper áp dụng", async () => {
    addMember(fakeStore, "u-an", "OWNER");
    const change = await ownerChangeService.create(ORG, "u-an", "an@clb.vn", {
      type: "ADD_OWNER",
      owners: [{ email: "moi@gmail.com", fullName: "Moi" }],
    });
    fakeStore.candidates.forEach((c) => (c.status = "CONFIRMED"));

    await expect(ownerChangeExecutor.sweep()).resolves.toEqual({ expired: 0, applied: 1 });
    expect(appOf(change.id).status).toBe("APPROVED");
  });
});
