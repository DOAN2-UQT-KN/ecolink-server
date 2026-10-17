import { Prisma, type PrismaClient, type RiskFlag } from "@prisma/client";
import prisma from "../../config/prisma.client";
import {
  REPORT_STATUS_ACCEPTED,
  REPORT_STATUS_IN_REVIEW,
  REPORT_STATUS_PENDING_VERIFICATION,
  REPORT_STATUS_REJECTED,
} from "../../constants/report-verification";
import { emitOutbox } from "../../outbox/outbox.writer";
import { OutboxEventType } from "../../outbox/outbox.types";
import { duplicateCheck } from "./checks/duplicate.check";
import { trustCheck } from "./checks/trust.check";
import { contextCheck } from "./checks/context.check";
import type { CheckRunner, VerificationContext } from "./checks/check-runner";
import { runCheckWithTimeout } from "./run-check";
import { assess, NoCompletedCheckError } from "./risk-engine";
import { verificationConfigService } from "./verification-config.service";
import type { Assessment, CheckResult } from "./verification.types";

export type VerificationOutcome = "COMPLETED" | "FAILED" | "SKIPPED";

export interface OrchestratorDeps {
  db: PrismaClient;
  checks: CheckRunner[];
  config: Pick<typeof verificationConfigService, "get">;
  now?: () => Date;
}

const STATUS_BY_FLAG: Record<RiskFlag, number> = {
  ACCEPT: REPORT_STATUS_ACCEPTED,
  REVIEW: REPORT_STATUS_IN_REVIEW,
  REJECT: REPORT_STATUS_REJECTED,
};

type Tx = Prisma.TransactionClient;

interface ReportInfo {
  id: string;
  userId: string | null;
  title: string;
  reportMediaFileIds: string[];
}

function toCheckRows(verificationId: string, results: CheckResult[]): Prisma.VerificationCheckCreateManyInput[] {
  return results.map((r) => ({
    verificationId,
    check: r.check,
    version: r.version,
    status: r.status,
    risk: r.risk,
    reasons: r.reasons,
    signals: r.signals as unknown as Prisma.InputJsonValue,
    evidence: r.evidence as Prisma.InputJsonValue,
    error: r.error ? (r.error as Prisma.InputJsonValue) : Prisma.DbNull,
    durationMs: r.durationMs,
  }));
}

/**
 * The only writer of verification results (specs/006 FR-009). One call handles one
 * REPORT_SUBMITTED{reportId, attempt}: run the checks, score them, and commit checks +
 * verdict + report status + REPORT_VERIFIED in one transaction.
 */
export function createVerificationOrchestrator(deps: OrchestratorDeps) {
  const { db, checks, config } = deps;
  const now = deps.now ?? (() => new Date());

  /** Moves the report out of PENDING (only if still pending) and points it at this attempt. */
  async function settleReport(tx: Tx, report: ReportInfo, verificationId: string, targetStatus: number, isVerify: boolean) {
    const changed = await tx.report.updateMany({
      where: { id: report.id, status: REPORT_STATUS_PENDING_VERIFICATION },
      data: { status: targetStatus, ...(isVerify ? { isVerify: true } : {}) },
    });
    const updated = await tx.report.update({
      where: { id: report.id },
      data: { latestVerificationId: verificationId },
      select: { status: true },
    });
    return { statusChanged: changed.count > 0, reportStatus: updated.status };
  }

  async function finalize(report: ReportInfo, verificationId: string, results: CheckResult[], a: Assessment): Promise<void> {
    await db.$transaction(async (tx) => {
      const claimed = await tx.reportVerification.updateMany({
        where: { id: verificationId, status: "RUNNING" },
        data: {
          status: "COMPLETED",
          riskScore: a.riskScore,
          flag: a.flag,
          reasons: a.reasons,
          engineVersion: a.engineVersion,
          completedAt: now(),
        },
      });
      if (claimed.count === 0) return; // another delivery already settled this attempt

      await tx.verificationCheck.createMany({ data: toCheckRows(verificationId, results) });
      const settled = await settleReport(tx, report, verificationId, STATUS_BY_FLAG[a.flag], a.flag === "ACCEPT");
      await emitOutbox(tx, {
        aggregateType: "report",
        aggregateId: report.id,
        eventType: OutboxEventType.REPORT_VERIFIED,
        dedupKey: `${OutboxEventType.REPORT_VERIFIED}:${verificationId}`,
        payload: {
          reportId: report.id,
          userId: report.userId,
          reportTitle: report.title,
          verificationId,
          ...settled,
          flag: a.flag,
          riskScore: a.riskScore,
          source: "ENGINE",
        },
      });
    });
  }

  /** Marks the attempt FAILED, then schedules the next attempt or, when exhausted, sends the report to review. */
  async function failAttempt(report: ReportInfo, verificationId: string, results: CheckResult[], attempt: number, maxAttempts: number) {
    await db.$transaction(async (tx) => {
      const claimed = await tx.reportVerification.updateMany({
        where: { id: verificationId, status: "RUNNING" },
        data: { status: "FAILED", completedAt: now() },
      });
      if (claimed.count === 0) return;

      if (results.length > 0) {
        await tx.verificationCheck.createMany({ data: toCheckRows(verificationId, results) });
      }

      if (attempt < maxAttempts) {
        await emitOutbox(tx, {
          aggregateType: "report",
          aggregateId: report.id,
          eventType: OutboxEventType.REPORT_SUBMITTED,
          dedupKey: `${OutboxEventType.REPORT_SUBMITTED}:${report.id}:${attempt + 1}`,
          payload: {
            reportId: report.id,
            userId: report.userId,
            attempt: attempt + 1,
            reportMediaFileIds: report.reportMediaFileIds,
          },
        });
        return;
      }

      const settled = await settleReport(tx, report, verificationId, REPORT_STATUS_IN_REVIEW, false);
      await emitOutbox(tx, {
        aggregateType: "report",
        aggregateId: report.id,
        eventType: OutboxEventType.REPORT_VERIFIED,
        dedupKey: `${OutboxEventType.REPORT_VERIFIED}:${verificationId}`,
        payload: {
          reportId: report.id,
          userId: report.userId,
          reportTitle: report.title,
          verificationId,
          ...settled,
          flag: null,
          riskScore: null,
          source: "ENGINE",
          exhausted: true,
        },
      });
    });
  }

  /** Creates the attempt, or resumes it if a previous delivery died mid-way; null = already settled. */
  async function startAttempt(reportId: string, attempt: number, pipelineVersion: string): Promise<string | null> {
    try {
      const created = await db.reportVerification.create({
        data: { reportId, attempt, status: "RUNNING", pipelineVersion },
      });
      return created.id;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      const existing = await db.reportVerification.findUnique({
        where: { reportId_attempt: { reportId, attempt } },
      });
      return existing?.status === "RUNNING" ? existing.id : null;
    }
  }

  async function handle({ reportId, attempt }: { reportId: string; attempt: number }): Promise<VerificationOutcome> {
    const [pipeline, engine, checksCfg] = await Promise.all([
      config.get("pipeline"),
      config.get("engine"),
      config.get("checks"),
    ]);

    const report = await db.report.findUnique({
      where: { id: reportId },
      include: { reportMediaFiles: { where: { deletedAt: null }, include: { media: true } } },
    });
    if (!report || report.deletedAt) {
      console.warn(`[verification] report ${reportId} not found or deleted; skipping attempt ${attempt}`);
      return "SKIPPED";
    }

    const verificationId = await startAttempt(reportId, attempt, pipeline.version);
    if (!verificationId) return "SKIPPED";

    const info: ReportInfo = {
      id: report.id,
      userId: report.userId,
      title: report.titleVi ?? report.title ?? "",
      reportMediaFileIds: report.reportMediaFiles.map((f) => f.id),
    };
    const maxAttempts = pipeline.value.maxAttempts;

    try {
      const ctx: VerificationContext = {
        report: {
          id: report.id,
          userId: report.userId,
          category: report.category,
          latitude: report.latitude,
          longitude: report.longitude,
          createdAt: report.createdAt,
        },
        media: report.reportMediaFiles.map((f) => ({
          mediaId: f.mediaId,
          reportMediaFileId: f.id,
          url: f.media.url,
          captureSource: f.captureSource,
        })),
        attempt,
        checksConfig: checksCfg.value,
      };

      const results = await Promise.all(
        checks.map((c) => runCheckWithTimeout(c, ctx, pipeline.value.checkTimeoutMs)),
      );

      let assessment: Assessment;
      try {
        assessment = assess(results, engine.value, engine.version);
      } catch (err) {
        if (!(err instanceof NoCompletedCheckError)) throw err;
        await failAttempt(info, verificationId, results, attempt, maxAttempts);
        return "FAILED";
      }
      await finalize(info, verificationId, results, assessment);
      return "COMPLETED";
    } catch (err) {
      // Unexpected error (DB, network): close this attempt and schedule the next one. If even that
      // fails, rethrow so SQS redelivers and startAttempt resumes the RUNNING row.
      console.error(`[verification] attempt ${attempt} of report ${reportId} failed:`, err);
      try {
        await failAttempt(info, verificationId, [], attempt, maxAttempts);
      } catch {
        throw err;
      }
      return "FAILED";
    }
  }

  return { handle };
}

export const verificationOrchestrator = createVerificationOrchestrator({
  db: prisma,
  checks: [duplicateCheck, trustCheck, contextCheck],
  config: verificationConfigService,
});
