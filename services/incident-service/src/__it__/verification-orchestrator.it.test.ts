/**
 * Verification orchestrator (specs/006, plan P05) against real Postgres: attempt bookkeeping,
 * the atomic finalize, retries up to maxAttempts, duplicate deliveries and resume from RUNNING.
 * Checks are fakes; SQS and ai-service are not involved.
 */
import { randomUUID } from "node:crypto";
import * as outboxWriter from "../outbox/outbox.writer";
import { prisma, resetTables } from "./setup/test-db";
import { createVerificationOrchestrator } from "../modules/verification/verification.orchestrator";
import { verificationConfigService } from "../modules/verification/verification-config.service";
import { contextCheck } from "../modules/verification/checks/context.check";
import { notAvailableResult, type CheckRunner } from "../modules/verification/checks/check-runner";
import type { CheckName, CheckResult } from "../modules/verification/verification.types";
import type { ReasonCode } from "../constants/report-verification";

const TIMEOUT_MS = 200;

// Real seeded config, with a short check timeout so the hanging-check case stays fast.
const config = {
  get: (async (key: Parameters<typeof verificationConfigService.get>[0]) => {
    const entry = await verificationConfigService.get(key);
    return key === "pipeline"
      ? { ...entry, value: { ...(entry.value as object), checkTimeoutMs: TIMEOUT_MS } }
      : entry;
  }) as typeof verificationConfigService.get,
};

function fake(name: CheckName, risk: number, reasons: ReasonCode[] = []): CheckRunner {
  return {
    name,
    signalNames: ["s"],
    version: () => `${name.toLowerCase()}@test`,
    run: async (): Promise<CheckResult> => ({
      check: name,
      version: `${name.toLowerCase()}@test`,
      status: "COMPLETED",
      risk,
      reasons,
      signals: [{ name: "s", status: "COMPLETED", risk }],
      evidence: {},
      durationMs: 1,
    }),
  };
}

const hanging = (name: CheckName): CheckRunner => ({
  name,
  signalNames: ["s"],
  version: () => "hang@test",
  run: () => new Promise<CheckResult>(() => undefined),
});

const orchestrator = (checks: CheckRunner[]) => createVerificationOrchestrator({ db: prisma, checks, config });
// DuplicateCheck is real since P06 (calls ai-service); a NOT_AVAILABLE fake keeps this offline.
const duplicateNotAvailable: CheckRunner = {
  name: "DUPLICATE",
  signalNames: ["phash", "orb", "internet"],
  version: (cfg) => cfg.duplicate.version,
  run: async (ctx) => notAvailableResult(duplicateNotAvailable, ctx.checksConfig),
};
// TrustCheck is real since P07 (always completes on the image source); keep a NOT_AVAILABLE fake.
const trustNotAvailable: CheckRunner = {
  name: "TRUST",
  signalNames: ["capture", "reject_history", "account_age"],
  version: (cfg) => cfg.trust.version,
  run: async (ctx) => notAvailableResult(trustNotAvailable, ctx.checksConfig),
};
const stubs = () => orchestrator([duplicateNotAvailable, trustNotAvailable, contextCheck]);

async function seedReport(over: { status?: number; deletedAt?: Date } = {}) {
  const userId = randomUUID();
  const report = await prisma.report.create({
    data: { userId, title: "Rác ven kênh", status: over.status ?? 12, deletedAt: over.deletedAt ?? null },
  });
  const media = await prisma.media.create({ data: { url: "https://res.cloudinary.com/x/image/upload/a.jpg", type: "REPORT" } });
  await prisma.reportMediaFile.create({ data: { reportId: report.id, mediaId: media.id } });
  return report;
}

const outbox = (reportId: string, eventType: string) =>
  prisma.outboxEvent.findMany({ where: { aggregateId: reportId, eventType }, orderBy: { createdAt: "asc" } });

describe("[it] verification orchestrator (P05)", () => {
  beforeEach(async () => {
    await resetTables();
    verificationConfigService.clearCache();
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("ACCEPT: commits checks, verdict, report 21 and REPORT_VERIFIED together", async () => {
    const report = await seedReport();
    const outcome = await orchestrator([fake("DUPLICATE", 0), fake("TRUST", 0.22), fake("CONTEXT", 0)]).handle({
      reportId: report.id,
      attempt: 1,
    });

    expect(outcome).toBe("COMPLETED");
    const v = await prisma.reportVerification.findFirstOrThrow({ where: { reportId: report.id }, include: { checks: true } });
    expect(v).toMatchObject({ status: "COMPLETED", flag: "ACCEPT", pipelineVersion: "2.3.0", engineVersion: "rules@3.0.0" });
    expect(v.checks).toHaveLength(3);
    const after = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
    expect(after).toMatchObject({ status: 21, isVerify: true, latestVerificationId: v.id });
    const events = await outbox(report.id, "REPORT_VERIFIED");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ statusChanged: true, reportStatus: 21, flag: "ACCEPT", source: "ENGINE" });
  });

  it("REVIEW: duplicate + gallery photo sends the report to 9", async () => {
    const report = await seedReport();
    await orchestrator([
      fake("DUPLICATE", 0.9, ["DUP_NEAR_IMAGE_MATCH"]),
      fake("TRUST", 0.32, ["TRUST_NOT_LIVE_CAPTURE"]),
      fake("CONTEXT", 0),
    ]).handle({ reportId: report.id, attempt: 1 });

    const v = await prisma.reportVerification.findFirstOrThrow({ where: { reportId: report.id } });
    expect(v.flag).toBe("REVIEW");
    expect(v.reasons).toEqual(["DUP_NEAR_IMAGE_MATCH", "TRUST_NOT_LIVE_CAPTURE"]);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).status).toBe(9);
  });

  it("a late result keeps a report that is no longer pending", async () => {
    const report = await seedReport({ status: 21 });
    await orchestrator([fake("DUPLICATE", 0.9), fake("TRUST", 0.32), fake("CONTEXT", 0)]).handle({
      reportId: report.id,
      attempt: 1,
    });

    const v = await prisma.reportVerification.findFirstOrThrow({ where: { reportId: report.id } });
    expect(v.status).toBe("COMPLETED");
    const after = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
    expect(after).toMatchObject({ status: 21, latestVerificationId: v.id });
    const [event] = await outbox(report.id, "REPORT_VERIFIED");
    expect(event.payload).toMatchObject({ statusChanged: false, reportStatus: 21 });
  });

  it("retries while no check completes, then sends the report to review after 3 attempts", async () => {
    const report = await seedReport();

    expect(await stubs().handle({ reportId: report.id, attempt: 1 })).toBe("FAILED");
    let submitted = await outbox(report.id, "REPORT_SUBMITTED");
    expect(submitted.map((e) => (e.payload as { attempt: number }).attempt)).toEqual([2]);

    await stubs().handle({ reportId: report.id, attempt: 2 });
    await stubs().handle({ reportId: report.id, attempt: 3 });

    submitted = await outbox(report.id, "REPORT_SUBMITTED");
    expect(submitted.map((e) => (e.payload as { attempt: number }).attempt)).toEqual([2, 3]);
    const attempts = await prisma.reportVerification.findMany({ where: { reportId: report.id } });
    expect(attempts.map((a) => a.status)).toEqual(["FAILED", "FAILED", "FAILED"]);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).status).toBe(9);
    const [verified] = await outbox(report.id, "REPORT_VERIFIED");
    expect(verified.payload).toMatchObject({ exhausted: true, statusChanged: true, reportStatus: 9, flag: null });
  });

  it("handles a duplicate delivery once, sequentially and concurrently", async () => {
    const checks = [fake("DUPLICATE", 0), fake("TRUST", 0), fake("CONTEXT", 0)];
    const a = await seedReport();
    await orchestrator(checks).handle({ reportId: a.id, attempt: 1 });
    expect(await orchestrator(checks).handle({ reportId: a.id, attempt: 1 })).toBe("SKIPPED");

    const b = await seedReport();
    await Promise.all([
      orchestrator(checks).handle({ reportId: b.id, attempt: 1 }),
      orchestrator(checks).handle({ reportId: b.id, attempt: 1 }),
    ]);

    for (const id of [a.id, b.id]) {
      expect(await prisma.reportVerification.count({ where: { reportId: id } })).toBe(1);
      expect(await prisma.verificationCheck.count({ where: { verification: { reportId: id } } })).toBe(3);
      expect(await outbox(id, "REPORT_VERIFIED")).toHaveLength(1);
    }
  });

  it("resumes an attempt left RUNNING by a crashed delivery", async () => {
    const report = await seedReport();
    const stuck = await prisma.reportVerification.create({
      data: { reportId: report.id, attempt: 1, status: "RUNNING", pipelineVersion: "2.3.0" },
    });
    await orchestrator([fake("DUPLICATE", 0), fake("TRUST", 0), fake("CONTEXT", 0)]).handle({
      reportId: report.id,
      attempt: 1,
    });
    const v = await prisma.reportVerification.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(v.status).toBe("COMPLETED");
  });

  it("a hanging DuplicateCheck fails on timeout and forces review", async () => {
    const report = await seedReport();
    await orchestrator([hanging("DUPLICATE"), fake("TRUST", 0), fake("CONTEXT", 0)]).handle({
      reportId: report.id,
      attempt: 1,
    });

    const dup = await prisma.verificationCheck.findFirstOrThrow({ where: { check: "DUPLICATE" } });
    expect(dup.status).toBe("FAILED");
    expect(dup.error).toMatchObject({ code: "TIMEOUT" });
    expect(dup.durationMs).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
    expect(dup.durationMs).toBeLessThan(1000);
    const v = await prisma.reportVerification.findFirstOrThrow({ where: { reportId: report.id } });
    expect(v.flag).toBe("REVIEW");
    expect(v.reasons).toContain("SYS_CHECK_FAILED_DUPLICATE");
  });

  it("writes nothing when the finalize transaction fails", async () => {
    const report = await seedReport();
    jest.spyOn(outboxWriter, "emitOutbox").mockRejectedValue(new Error("outbox down"));
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      orchestrator([fake("DUPLICATE", 0), fake("TRUST", 0), fake("CONTEXT", 0)]).handle({
        reportId: report.id,
        attempt: 1,
      }),
    ).rejects.toThrow("outbox down");

    const v = await prisma.reportVerification.findFirstOrThrow({ where: { reportId: report.id } });
    expect(v.status).toBe("RUNNING");
    expect(await prisma.verificationCheck.count()).toBe(0);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).status).toBe(12);
  });

  it("skips a soft-deleted report", async () => {
    const report = await seedReport({ deletedAt: new Date() });
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await stubs().handle({ reportId: report.id, attempt: 1 })).toBe("SKIPPED");
    expect(await prisma.reportVerification.count()).toBe(0);
  });
});
