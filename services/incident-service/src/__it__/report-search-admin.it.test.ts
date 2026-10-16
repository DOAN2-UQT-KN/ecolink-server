/**
 * Admin report search (specs/008): moderation filter + risk order, latest verification with its
 * score for admins only, score on GET /:id for admins only.
 */
import { randomUUID } from "node:crypto";
import { validationResult } from "express-validator";
import { prisma, resetTables } from "./setup/test-db";
import { reportService } from "../modules/report/report.service";
import { reportSearchQueryValidators } from "../modules/report/report.validator";

const ADMIN = randomUUID();
const OWNER = randomUUID();

async function seed(status: number, riskScore: number | null, over: { moderatedBy?: string; withVerification?: boolean } = {}) {
  const report = await prisma.report.create({
    data: { userId: OWNER, title: `r ${status} ${riskScore}`, status, moderatedBy: over.moderatedBy ?? null },
  });
  if (over.withVerification === false) return report;
  const v = await prisma.reportVerification.create({
    data: {
      reportId: report.id,
      status: "COMPLETED",
      pipelineVersion: "2.3.0",
      riskScore,
      flag: riskScore === null ? null : riskScore >= 0.7 ? "REJECT" : "REVIEW",
      reasons: [],
    },
  });
  return prisma.report.update({ where: { id: report.id }, data: { latestVerificationId: v.id } });
}

const ids = (page: { reports: { id: string }[] }) => page.reports.map((r) => r.id);

describe("[it] admin report search (specs/008)", () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("moderation=REVIEW: status 9 only, highest risk first, unscored last; ignores status/sort", async () => {
    const low = await seed(9, 0.32);
    const high = await seed(9, 0.61);
    const unscored = await seed(9, null);
    await seed(21, 0.05);
    await seed(2, 0.8);

    const page = await reportService.searchReports(
      { moderation: "REVIEW", statuses: [21], sortBy: "createdAt", sortOrder: "desc", page: 1, limit: 10 },
      ADMIN,
      true,
    );
    expect(ids(page)).toEqual([high.id, low.id, unscored.id]);
    expect(page.total).toBe(3);
    expect(page.reports[0]).toMatchObject({ latestVerification: { status: "COMPLETED", flag: "REVIEW", riskScore: 0.61 } });
  });

  it("moderation=REJECT: auto-rejected only (not admin-banned, not legacy bans)", async () => {
    const auto = await seed(2, 0.76);
    await seed(2, 0.9, { moderatedBy: ADMIN });
    await seed(2, null, { withVerification: false });

    const page = await reportService.searchReports({ moderation: "REJECT", page: 1, limit: 10 }, ADMIN, true);
    expect(ids(page)).toEqual([auto.id]);
  });

  it("admin rows carry the latest verification; reports without one get null", async () => {
    const scored = await seed(9, 0.61);
    const legacy = await seed(21, null, { withVerification: false });

    const page = await reportService.searchReports({ page: 1, limit: 10 }, ADMIN, true);
    const byId = new Map(page.reports.map((r) => [r.id, r]));
    expect(byId.get(scored.id)?.latestVerification).toEqual({ status: "COMPLETED", flag: "REVIEW", riskScore: 0.61 });
    expect(byId.get(legacy.id)?.latestVerification).toBeNull();
  });

  it("non-admins get no latest verification and the moderation filter is ignored", async () => {
    const review = await seed(9, 0.61);
    const accepted = await seed(21, 0.05);

    const page = await reportService.searchReports({ moderation: "REVIEW", page: 1, limit: 10 }, OWNER, false);
    expect(new Set(ids(page))).toEqual(new Set([review.id, accepted.id]));
    for (const r of page.reports) expect(r).not.toHaveProperty("latestVerification");
  });

  it("GET /:id adds the risk score for admins only", async () => {
    const r = await seed(9, 0.61);

    const asAdmin = await reportService.getReportDetail(r.id, ADMIN, true);
    expect(asAdmin?.latestVerification).toEqual({ status: "COMPLETED", flag: "REVIEW", riskScore: 0.61 });
    const asOwner = await reportService.getReportDetail(r.id, OWNER, false);
    expect(asOwner?.latestVerification).toEqual({ status: "COMPLETED", flag: "REVIEW" });
  });

  it("rejects an unknown moderation value", async () => {
    const req = { query: { moderation: "FOO" } } as never;
    await Promise.all(reportSearchQueryValidators.map((v) => v.run(req)));
    expect(validationResult(req).array().map((e) => e.msg)).toContain("moderation must be REVIEW or REJECT");
  });
});
