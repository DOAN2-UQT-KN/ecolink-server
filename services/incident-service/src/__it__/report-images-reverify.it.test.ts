/**
 * Adding images to a report (specs/006, plan P10a) against real Postgres: a new verification
 * attempt instead of a reset, no stuck PENDING, live captures, and background jobs written in the
 * transaction (no direct enqueue).
 */
jest.mock("../modules/organization/identity-user.client", () => ({
  ...jest.requireActual("../modules/organization/identity-user.client"),
  fetchOrganizationOwnersByUserIds: jest.fn().mockResolvedValue(new Map()),
  isIdentityCallableUserId: () => false,
}));

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, resetTables } from "./setup/test-db";
import { reportService } from "../modules/report/report.service";
import { issueCapture } from "../modules/report/capture/capture.service";
import { backgroundJobDispatcher } from "../queue/register";

const ENV = { CLOUDINARY_CLOUD_NAME: "ecolink", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s" };
const saved: Record<string, string | undefined> = {};
const url = (path: string) => `https://res.cloudinary.com/ecolink/image/upload/v1/${path}.jpg`;

async function seedReport(status: number, withVerification: boolean) {
  const userId = randomUUID();
  const media = await prisma.media.create({ data: { url: url("uploads/old"), type: "REPORT" } });
  const report = await prisma.report.create({
    data: {
      userId,
      title: "Rác ven kênh",
      status,
      isVerify: status === 21,
      reportMediaFiles: { create: { mediaId: media.id, uploadedBy: userId } },
    },
  });
  if (withVerification) {
    const v = await prisma.reportVerification.create({
      data: { reportId: report.id, attempt: 1, status: "COMPLETED", pipelineVersion: "2.3.0", flag: "ACCEPT", riskScore: 0.1 },
    });
    await prisma.report.update({ where: { id: report.id }, data: { latestVerificationId: v.id } });
  }
  return { report, userId };
}

const submitted = (reportId: string) =>
  prisma.outboxEvent.findMany({ where: { aggregateId: reportId, eventType: "REPORT_SUBMITTED" } });

describe("[it] add images re-verifies (P10a)", () => {
  const enqueueSpy = jest.spyOn(backgroundJobDispatcher, "enqueue");

  beforeAll(() => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetTables();
    await prisma.$executeRaw(Prisma.sql`TRUNCATE TABLE "media_captures" CASCADE`);
    enqueueSpy.mockClear();
  });

  it("an accepted report stays accepted and gets attempt 2; attempt 1 is kept", async () => {
    const { report, userId } = await seedReport(21, true);
    await reportService.addReportImages(report.id, userId, { images: [{ url: url("uploads/new") }] });

    const after = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
    expect(after).toMatchObject({ status: 21, aiVerified: false, isVerify: true });
    const events = await submitted(report.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ attempt: 2 });
    expect((events[0].payload as { reportMediaFileIds: string[] }).reportMediaFileIds).toHaveLength(2);
    expect(await prisma.reportVerification.count({ where: { reportId: report.id } })).toBe(1);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("a pending report without verification gets attempt 1; a queued duplicate key is skipped", async () => {
    const { report, userId } = await seedReport(12, false);
    await prisma.outboxEvent.create({
      data: {
        aggregateType: "report",
        aggregateId: report.id,
        eventType: "REPORT_SUBMITTED",
        payload: { reportId: report.id, attempt: 1 },
        dedupKey: `REPORT_SUBMITTED:${report.id}:1`,
        status: 12,
      },
    });
    await reportService.addReportImages(report.id, userId, { images: [{ url: url("uploads/new") }] });

    expect(await submitted(report.id)).toHaveLength(1);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).status).toBe(12);
  });

  it("marks an image uploaded under a valid capture as LIVE", async () => {
    const { report, userId } = await seedReport(12, false);
    const { captureId } = await issueCapture(userId);
    await reportService.addReportImages(report.id, userId, { images: [{ url: url(`captures/${captureId}`), captureId }] });

    const live = await prisma.reportMediaFile.findFirst({ where: { reportId: report.id, captureId } });
    expect(live?.captureSource).toBe("LIVE");
  });

  it("writes ANALYZE_REPORT for the new images with a background_jobs row of the same id", async () => {
    const { report, userId } = await seedReport(12, false);
    await reportService.addReportImages(report.id, userId, { images: [{ url: url("uploads/a") }, { url: url("uploads/b") }] });

    const [job] = await prisma.outboxEvent.findMany({ where: { aggregateId: report.id, eventType: "ANALYZE_REPORT" } });
    expect((job.payload as { reportMediaFileIds: string[] }).reportMediaFileIds).toHaveLength(2);
    expect(await prisma.backgroundJob.findUnique({ where: { id: job.id } })).toMatchObject({
      jobType: "ANALYZE_REPORT",
      status: 12,
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
