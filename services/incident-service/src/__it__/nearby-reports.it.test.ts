/**
 * DuplicateCheck support on the incident side (specs/006 P06): nearby same-category reports
 * for the "support the existing report" hint, and the geo-by-ids route used by ai-service's backfill.
 */
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { prisma, resetTables } from "./setup/test-db";
import { findNearbyReports } from "../modules/verification/checks/nearby-reports";
import { verificationConfigService } from "../modules/verification/verification-config.service";
import internalRoutes from "../internal/internal.routes";
import type { VerificationContext } from "../modules/verification/checks/check-runner";

const HERE = { latitude: 10.79, longitude: 106.68 };
const north = (m: number) => HERE.latitude + m / 111_320;
const HOUR = 3600_000;

async function report(over: { metres?: number; hoursAgo?: number; category?: "WATERWAY" | "MARKET"; status?: number } = {}) {
  return prisma.report.create({
    data: {
      userId: randomUUID(),
      title: "r",
      latitude: north(over.metres ?? 0),
      longitude: HERE.longitude,
      category: over.category ?? "WATERWAY",
      status: over.status ?? 12,
      createdAt: new Date(Date.now() - (over.hoursAgo ?? 0) * HOUR),
    },
  });
}

describe("[it] DuplicateCheck incident helpers (P06)", () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("findNearbyReports: same category, within 100 m and 24 h, not rejected", async () => {
    const subject = await report();
    const near = await report({ metres: 50, hoursAgo: 2 });
    await report({ metres: 150, hoursAgo: 2 });
    await report({ metres: 50, hoursAgo: 2, category: "MARKET" });
    await report({ metres: 50, hoursAgo: 30 });
    await report({ metres: 30, hoursAgo: 1, status: 2 });

    const { value } = await verificationConfigService.get("checks");
    const ctx = {
      report: {
        id: subject.id,
        userId: subject.userId,
        category: subject.category,
        latitude: subject.latitude,
        longitude: subject.longitude,
        createdAt: subject.createdAt,
      },
      media: [],
      attempt: 1,
      checksConfig: value,
    } as VerificationContext;

    const rows = await findNearbyReports(ctx);
    expect(rows.map((r) => r.reportId)).toEqual([near.id]);
    expect(rows[0].distanceM).toBeGreaterThanOrEqual(48);
    expect(rows[0].distanceM).toBeLessThanOrEqual(52);
  });

  it("geo-by-ids: needs the AI key and returns where/when/category", async () => {
    const r = await report({ metres: 10 });
    process.env.INTERNAL_AI_API_KEY = "it-key";
    const app = express().use(express.json()).use("/internal/v1", internalRoutes);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/v1/reports/geo-by-ids`;
    try {
      const denied = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-api-key": "wrong" },
        body: JSON.stringify({ ids: [r.id] }),
      });
      expect(denied.status).toBe(401);

      const ok = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-api-key": "it-key" },
        body: JSON.stringify({ ids: [r.id] }),
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { data: { reports: Record<string, unknown>[] } };
      expect(body.data.reports).toEqual([
        expect.objectContaining({ id: r.id, latitude: r.latitude, longitude: r.longitude, category: "WATERWAY" }),
      ]);

      const bad = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-api-key": "it-key" },
        body: JSON.stringify({ ids: ["not-a-uuid"] }),
      });
      expect(bad.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
