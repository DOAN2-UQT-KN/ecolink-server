/**
 * TrustCheck (specs/006, plan P07) against real Postgres: the 90-day history query
 * (current report excluded, soft-deleted included) and identity failures.
 */
const voteProfileMock = jest.fn();
jest.mock("../modules/organization/identity-user.client", () => ({
  ...jest.requireActual("../modules/organization/identity-user.client"),
  fetchUserVoteProfile: (...a: unknown[]) => voteProfileMock(...a),
}));

import { randomUUID } from "node:crypto";
import { prisma, resetTables } from "./setup/test-db";
import { trustCheck } from "../modules/verification/checks/trust.check";
import { verificationConfigService } from "../modules/verification/verification-config.service";
import type { VerificationContext } from "../modules/verification/checks/check-runner";

const DAY = 86_400_000;

async function seed() {
  const userId = randomUUID();
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY);
  await prisma.report.createMany({
    data: [
      { userId, title: "rejected", status: 2, createdAt: at(10) },
      { userId, title: "rejected+deleted", status: 2, createdAt: at(20), deletedAt: new Date() },
      { userId, title: "accepted", status: 21, createdAt: at(30) },
      { userId, title: "too old", status: 2, createdAt: at(100) },
      { userId: randomUUID(), title: "someone else", status: 2, createdAt: at(5) },
    ],
  });
  const current = await prisma.report.create({ data: { userId, title: "current", latitude: 10.79, longitude: 106.68 } });
  const { value } = await verificationConfigService.get("checks");
  return {
    report: { id: current.id, userId, category: current.category, latitude: 10.79, longitude: 106.68, createdAt: current.createdAt },
    media: [{ mediaId: "m1", reportMediaFileId: "f1", url: "u", captureSource: "LIVE" }],
    attempt: 1,
    checksConfig: value,
  } as VerificationContext;
}

describe("[it] TrustCheck (P07)", () => {
  beforeEach(async () => {
    await resetTables();
    voteProfileMock.mockReset();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("counts 90 days of the user's other reports, deleted ones included", async () => {
    voteProfileMock.mockResolvedValue({ createdAt: new Date(Date.now() - 140 * DAY) });
    const ctx = await seed();
    const r = await trustCheck.run(ctx, new AbortController().signal);

    expect(r.evidence).toMatchObject({ totalReports90d: 3, rejected90d: 2, accountAgeDays: 140 });
    expect(r.signals.find((s) => s.name === "reject_history")?.risk).toBeCloseTo(3 / 8, 4);
    expect(r.status).toBe("COMPLETED");
    expect(voteProfileMock).toHaveBeenCalledWith({ userId: ctx.report.userId, latitude: 10.79, longitude: 106.68 });
  });

  it("identity down -> account_age FAILED, check still COMPLETED", async () => {
    voteProfileMock.mockResolvedValue(null);
    const r = await trustCheck.run(await seed(), new AbortController().signal);
    expect(r.signals.find((s) => s.name === "account_age")?.status).toBe("FAILED");
    expect(r.status).toBe("COMPLETED");
  });
});
