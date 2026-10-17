/**
 * POST /reports gate (specs/006, plan P02) against real Postgres + PostGIS:
 * service area (BR-113), 5 reports / 24 h sliding window under concurrency (BR-114),
 * Idempotency-Key replay (BR-115), and the single REPORT_SUBMITTED outbox row.
 */
jest.mock("../queue/register", () => ({
  backgroundJobDispatcher: { enqueue: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("../modules/organization/identity-user.client", () => ({
  ...jest.requireActual("../modules/organization/identity-user.client"),
  fetchOrganizationOwnersByUserIds: jest.fn().mockResolvedValue(new Map()),
  isIdentityCallableUserId: () => false,
}));

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, resetTables } from "./setup/test-db";
import { reportService } from "../modules/report/report.service";
import { HttpError } from "../constants/http-status";
import type { CreateReportRequest } from "../modules/report/report.dto";

const HCMC = { latitude: 10.79, longitude: 106.68 };
const HANOI = { latitude: 21.03, longitude: 105.85 };
const HOUR = 3600_000;

const body = (over: Partial<CreateReportRequest> = {}): CreateReportRequest => ({
  title: "Rác ven kênh",
  ...HCMC,
  category: "WATERWAY",
  wasteTypes: ["HOUSEHOLD"],
  images: [{ url: "https://res.cloudinary.com/ecolink/image/upload/a.jpg" }],
  ...over,
});

const seedServiceArea = () =>
  prisma.$executeRaw(Prisma.sql`
    INSERT INTO service_areas (id, name, geog, active) VALUES (uuid_generate_v4(), 'TP.HCM',
      ST_GeogFromText('SRID=4326;MULTIPOLYGON(((106.35 10.30,107.60 10.30,107.60 11.55,106.35 11.55,106.35 10.30)))'), true)`);

async function seedReports(userId: string, hoursAgo: number[], deletedIndex = -1): Promise<void> {
  const now = Date.now();
  for (const [i, h] of hoursAgo.entries()) {
    await prisma.report.create({
      data: {
        userId,
        title: `seed ${i}`,
        createdAt: new Date(now - h * HOUR),
        deletedAt: i === deletedIndex ? new Date() : null,
      },
    });
  }
}

const errorCode = (e: unknown) => (e instanceof HttpError ? e.statusResponse.code : String(e));
const countOutbox = () => prisma.outboxEvent.count({ where: { eventType: "REPORT_SUBMITTED" } });

describe("[it] report submit gate (P02)", () => {
  beforeEach(async () => {
    await resetTables();
    await prisma.$executeRaw(Prisma.sql`DELETE FROM service_areas`);
    await seedServiceArea();
  });

  afterAll(async () => {
    // Restore the migration seed for other suites.
    await prisma.$executeRaw(Prisma.sql`DELETE FROM service_areas`);
    await seedServiceArea();
    await prisma.$disconnect();
  });

  it("creates a pending report and exactly one REPORT_SUBMITTED{attempt: 1}", async () => {
    const userId = randomUUID();
    const { report, replayed } = await reportService.createReport(userId, body());

    expect(replayed).toBe(false);
    expect(report).toMatchObject({ status: 12, category: "WATERWAY", wasteTypes: ["HOUSEHOLD"], wasteType: "household" });
    const events = await prisma.outboxEvent.findMany({ where: { aggregateId: report.id }, orderBy: { createdAt: "asc" } });
    // REPORT_SUBMITTED + the two background jobs, all written with the report (P10).
    expect(events.map((e) => e.eventType).sort()).toEqual(["ANALYZE_REPORT", "REPORT_SUBMITTED", "TRANSLATE_TEXT"]);
    expect(events.find((e) => e.eventType === "REPORT_SUBMITTED")?.payload).toMatchObject({ reportId: report.id, attempt: 1 });
    for (const job of events.filter((e) => e.eventType !== "REPORT_SUBMITTED")) {
      expect(await prisma.backgroundJob.findUnique({ where: { id: job.id } })).toMatchObject({ jobType: job.eventType });
    }
    const files = await prisma.reportMediaFile.findMany({ where: { reportId: report.id } });
    expect(files.map((f) => f.captureSource)).toEqual(["GALLERY"]);
  });

  it("rejects a point outside the service area and writes nothing", async () => {
    const err = await reportService.createReport(randomUUID(), body(HANOI)).catch((e: unknown) => e);
    expect(errorCode(err)).toBe("REPORT_OUT_OF_SERVICE_AREA");
    expect(await prisma.report.count()).toBe(0);
    expect(await countOutbox()).toBe(0);
  });

  it("skips the area check when SERVICE_AREA_CHECK_DISABLED=true", async () => {
    process.env.SERVICE_AREA_CHECK_DISABLED = "true";
    try {
      await expect(reportService.createReport(randomUUID(), body(HANOI))).resolves.toBeDefined();
    } finally {
      delete process.env.SERVICE_AREA_CHECK_DISABLED;
    }
  });

  it("fails open when no service area is active", async () => {
    await prisma.$executeRaw(Prisma.sql`UPDATE service_areas SET active = false`);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(reportService.createReport(randomUUID(), body(HANOI))).resolves.toBeDefined();
  });

  it("blocks the 6th report in 24 h (soft-deleted ones count) with retryAfter", async () => {
    const userId = randomUUID();
    await seedReports(userId, [23, 20, 10, 5, 1], 2);
    await seedReports(randomUUID(), [2]); // another user's report does not count

    const err = await reportService.createReport(userId, body()).catch((e: unknown) => e);
    expect(errorCode(err)).toBe("REPORT_RATE_LIMITED");
    const retryAfter = Date.parse((err as HttpError).data?.retryAfter);
    expect(Math.abs(retryAfter - (Date.now() + HOUR))).toBeLessThan(5_000);
  });

  it("uses a sliding window: a report older than 24 h no longer counts", async () => {
    const userId = randomUUID();
    await seedReports(userId, [25, 20, 10, 5, 1]);
    await expect(reportService.createReport(userId, body())).resolves.toBeDefined();
  });

  it("lets only one of two concurrent submits through at the limit", async () => {
    const userId = randomUUID();
    await seedReports(userId, [20, 10, 5, 1]);

    const results = await Promise.allSettled([
      reportService.createReport(userId, body()),
      reportService.createReport(userId, body()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(errorCode(rejected?.reason)).toBe("REPORT_RATE_LIMITED");
    expect(await prisma.report.count({ where: { userId } })).toBe(5);
  });

  it("replays the same report for a repeated Idempotency-Key, sequential and concurrent", async () => {
    const userId = randomUUID();
    const key = randomUUID();
    const first = await reportService.createReport(userId, body(), undefined, key);
    const second = await reportService.createReport(userId, body(), undefined, key);
    expect(second).toMatchObject({ replayed: true, report: { id: first.report.id } });

    const key2 = randomUUID();
    const [a, b] = await Promise.all([
      reportService.createReport(userId, body(), undefined, key2),
      reportService.createReport(userId, body(), undefined, key2),
    ]);
    expect(a.report.id).toBe(b.report.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);

    expect(await prisma.report.count({ where: { userId } })).toBe(2);
    expect(await countOutbox()).toBe(2);
  });

  it("replays instead of rate-limiting a retried 5th report", async () => {
    const userId = randomUUID();
    await seedReports(userId, [20, 10, 5, 1]);
    const key = randomUUID();
    const fifth = await reportService.createReport(userId, body(), undefined, key);
    await expect(reportService.createReport(userId, body(), undefined, key)).resolves.toMatchObject({
      replayed: true,
      report: { id: fifth.report.id },
    });
  });
});
