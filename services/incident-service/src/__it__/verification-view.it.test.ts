/**
 * Reading verification results (specs/006, plan P09, US7) against real Postgres:
 * owner vs stranger vs admin, latest attempt, and the rejected report detail.
 */
jest.mock("../modules/organization/identity-user.client", () => ({
  ...jest.requireActual("../modules/organization/identity-user.client"),
  fetchOrganizationOwnersByUserIds: jest.fn().mockResolvedValue(new Map()),
  isIdentityCallableUserId: () => false,
}));

import { randomUUID } from "node:crypto";
import { prisma, resetTables } from "./setup/test-db";
import { verificationViewService } from "../modules/verification/verification-view.service";
import { reportService } from "../modules/report/report.service";
import { HttpError } from "../constants/http-status";

const code = (e: unknown) => (e instanceof HttpError ? e.statusResponse.code : String(e));

async function seed(status = 9, attempts = 1) {
  const ownerId = randomUUID();
  const report = await prisma.report.create({ data: { userId: ownerId, title: "Rác ven kênh", status } });
  let latestId = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const v = await prisma.reportVerification.create({
      data: {
        reportId: report.id,
        attempt,
        status: "COMPLETED",
        pipelineVersion: "2.3.0",
        engineVersion: "rules@3.0.0",
        riskScore: 0.61,
        flag: "REVIEW",
        reasons: ["DUP_NEAR_IMAGE_MATCH", "TRUST_NEW_ACCOUNT"],
        completedAt: new Date(),
        checks: {
          create: {
            check: "DUPLICATE",
            version: "duplicate@2.0.0",
            status: "COMPLETED",
            risk: 0.9,
            reasons: ["DUP_NEAR_IMAGE_MATCH"],
            signals: [],
            evidence: { match: { report_id: "r-old", user_id: "u-other", distance_m: 120 } },
            durationMs: 10,
          },
        },
      },
    });
    latestId = v.id;
  }
  await prisma.report.update({ where: { id: report.id }, data: { latestVerificationId: latestId } });
  return { report, ownerId, latestId };
}

describe("[it] verification view (P09 US7)", () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("owner gets the public view, admin the full view, a stranger is refused", async () => {
    const { report, ownerId } = await seed();

    const owner = await verificationViewService.getForViewer(report.id, { userId: ownerId, isAdmin: false });
    expect(owner).toMatchObject({ flag: "REVIEW", issues: [{ code: "DUP_NEAR_IMAGE_MATCH" }] });
    expect(JSON.stringify(owner)).not.toContain("u-other");
    expect(owner).not.toHaveProperty("riskScore");

    const admin = await verificationViewService.getForViewer(report.id, { userId: randomUUID(), isAdmin: true });
    expect(admin).toMatchObject({ riskScore: 0.61, reasons: ["DUP_NEAR_IMAGE_MATCH", "TRUST_NEW_ACCOUNT"] });

    const err = await verificationViewService
      .getForViewer(report.id, { userId: randomUUID(), isAdmin: false })
      .catch((e: unknown) => e);
    expect(code(err)).toBe("FORBIDDEN");
  });

  it("returns VERIFICATION_NOT_FOUND before any attempt and REPORT_NOT_FOUND for unknown ids", async () => {
    const ownerId = randomUUID();
    const bare = await prisma.report.create({ data: { userId: ownerId, title: "t" } });
    expect(code(await verificationViewService.getForViewer(bare.id, { userId: ownerId, isAdmin: false }).catch((e) => e))).toBe(
      "VERIFICATION_NOT_FOUND",
    );
    expect(code(await verificationViewService.getForViewer(randomUUID(), { userId: ownerId, isAdmin: true }).catch((e) => e))).toBe(
      "REPORT_NOT_FOUND",
    );
  });

  it("serves the latest attempt and lists all attempts newest first", async () => {
    const { report, ownerId } = await seed(9, 2);
    const latest = await verificationViewService.getForViewer(report.id, { userId: ownerId, isAdmin: false });
    expect(latest.attempt).toBe(2);
    const all = await verificationViewService.listForAdmin(report.id);
    expect(all.map((v) => v.attempt)).toEqual([2, 1]);
  });

  it("shows a rejected report to its owner and admins only, with the verification summary", async () => {
    const { report, ownerId } = await seed(2);
    expect(await reportService.getReportDetail(report.id, randomUUID(), false)).toBeNull();

    const forOwner = await reportService.getReportDetail(report.id, ownerId, false);
    expect(forOwner).toMatchObject({ id: report.id, latestVerification: { status: "COMPLETED", flag: "REVIEW" } });
    expect(forOwner?.duplicateVerification).toBeNull();

    expect(await reportService.getReportDetail(report.id, randomUUID(), true)).not.toBeNull();
  });
});
