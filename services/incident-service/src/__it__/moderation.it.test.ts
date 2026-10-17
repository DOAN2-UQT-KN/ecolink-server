/**
 * Moderator queue and decisions (specs/006, plan P09, US6) against real Postgres:
 * ordering, tabs, compare-and-set between two admins, outbox notification.
 */
import { randomUUID } from "node:crypto";
import { prisma, resetTables } from "./setup/test-db";
import { moderationService } from "../modules/verification/moderation.service";
import { reportService } from "../modules/report/report.service";
import { HttpError } from "../constants/http-status";

const code = (e: unknown) => (e instanceof HttpError ? e.statusResponse.code : String(e));
const ADMIN = randomUUID();

async function seed(status: number, riskScore: number | null, over: { moderatedBy?: string; withVerification?: boolean } = {}) {
  const report = await prisma.report.create({
    data: { userId: randomUUID(), title: `r ${riskScore}`, status, moderatedBy: over.moderatedBy ?? null },
  });
  if (over.withVerification === false) return report;
  const v = await prisma.reportVerification.create({
    data: {
      reportId: report.id,
      status: "COMPLETED",
      pipelineVersion: "2.3.0",
      riskScore,
      flag: riskScore === null ? null : riskScore >= 0.7 ? "REJECT" : "REVIEW",
      reasons: ["DUP_NEAR_IMAGE_MATCH"],
    },
  });
  return prisma.report.update({ where: { id: report.id }, data: { latestVerificationId: v.id } });
}

const verifiedEvents = (reportId: string) =>
  prisma.outboxEvent.findMany({ where: { aggregateId: reportId, eventType: "REPORT_VERIFIED" } });

describe("[it] moderation (P09 US6)", () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("review queue: status 9 only, highest risk first, nulls last, with counts", async () => {
    const low = await seed(9, 0.4);
    const high = await seed(9, 0.61);
    const exhausted = await seed(9, null);
    await seed(21, 0.1);
    await seed(2, 0.8);

    const page = await moderationService.queue({ flag: "REVIEW" });
    expect(page.reports.map((r) => r.id)).toEqual([high.id, low.id, exhausted.id]);
    expect(page).toMatchObject({ total: 3, page: 1, limit: 20, totalPages: 1, counts: { review: 3, autoRejected: 1 } });
    expect(page.reports[0]).toMatchObject({ riskScore: 0.61, reasons: ["DUP_NEAR_IMAGE_MATCH"], thumbnailUrl: null });
  });

  it("auto-rejected tab excludes reports an admin already banned", async () => {
    const auto = await seed(2, 0.85);
    await seed(2, 0.9, { moderatedBy: ADMIN });
    await seed(2, null, { withVerification: false });

    const page = await moderationService.queue({ flag: "REJECT" });
    expect(page.reports.map((r) => r.id)).toEqual([auto.id]);
  });

  it("ACCEPT moves a report in review to 21 and notifies through the outbox", async () => {
    const r = await seed(9, 0.5);
    await moderationService.moderate(r.id, ADMIN, { decision: "ACCEPT" });

    const after = await prisma.report.findUniqueOrThrow({ where: { id: r.id } });
    expect(after).toMatchObject({ status: 21, isVerify: true, moderatedBy: ADMIN, moderationReasonCode: null });
    const [event] = await verifiedEvents(r.id);
    expect(event.payload).toMatchObject({ source: "MODERATOR", reportStatus: 21, statusChanged: true });
  });

  it("REJECT stores the reason code and note, and carries the note to the owner", async () => {
    const r = await seed(9, 0.5);
    await moderationService.moderate(r.id, ADMIN, { decision: "REJECT", reasonCode: "NOT_ON_SITE", note: " Ảnh mạng " });

    const after = await prisma.report.findUniqueOrThrow({ where: { id: r.id } });
    expect(after).toMatchObject({ status: 2, moderationReasonCode: "NOT_ON_SITE", rejectReason: "Ảnh mạng" });
    const [event] = await verifiedEvents(r.id);
    expect(event.payload).toMatchObject({ reportStatus: 2, rejectReason: "Ảnh mạng" });
  });

  it("refuses a second decision, also when two admins race", async () => {
    const r = await seed(9, 0.5);
    await moderationService.moderate(r.id, ADMIN, { decision: "ACCEPT" });
    expect(code(await moderationService.moderate(r.id, ADMIN, { decision: "ACCEPT" }).catch((e) => e))).toBe(
      "REPORT_ALREADY_MODERATED",
    );

    const race = await seed(9, 0.5);
    const results = await Promise.allSettled([
      moderationService.moderate(race.id, ADMIN, { decision: "ACCEPT" }),
      moderationService.moderate(race.id, randomUUID(), { decision: "REJECT", reasonCode: "INAPPROPRIATE_CONTENT" }),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(code(rejected?.reason)).toBe("REPORT_ALREADY_MODERATED");
    expect(await verifiedEvents(race.id)).toHaveLength(1);
  });

  it("can overturn an automatic rejection", async () => {
    const r = await seed(2, 0.85);
    await moderationService.moderate(r.id, ADMIN, { decision: "ACCEPT" });
    expect((await prisma.report.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(21);
  });

  it("returns REPORT_NOT_FOUND for unknown reports", async () => {
    expect(code(await moderationService.moderate(randomUUID(), ADMIN, { decision: "ACCEPT" }).catch((e) => e))).toBe(
      "REPORT_NOT_FOUND",
    );
  });

  it("legacy ban records who decided", async () => {
    const r = await seed(12, null, { withVerification: false });
    await reportService.adminBanReport(r.id, ADMIN, "spam", "INAPPROPRIATE_CONTENT");
    const after = await prisma.report.findUniqueOrThrow({ where: { id: r.id } });
    expect(after).toMatchObject({ status: 2, moderatedBy: ADMIN, moderationReasonCode: "INAPPROPRIATE_CONTENT" });
    expect(after.moderatedAt).toBeInstanceOf(Date);
    // The owner notice now goes through the outbox (P10), not a direct call.
    const [event] = await verifiedEvents(r.id);
    expect(event.payload).toMatchObject({ source: "MODERATOR", reportStatus: 2, rejectReason: "spam" });
  });
});
