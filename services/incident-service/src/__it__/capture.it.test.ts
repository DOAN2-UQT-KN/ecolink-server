/**
 * Server-issued camera captures (specs/006, plan P03) against real Postgres: issuing and
 * signing, compare-and-set consumption, and LIVE/GALLERY on created reports.
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
import { v2 as cloudinary } from "cloudinary";
import { prisma, resetTables } from "./setup/test-db";
import { issueCapture, resolveCaptureSources } from "../modules/report/capture/capture.service";
import { reportService } from "../modules/report/report.service";

const ENV = { CLOUDINARY_CLOUD_NAME: "ecolink", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s", SERVICE_AREA_CHECK_DISABLED: "true" };
const saved: Record<string, string | undefined> = {};
const captureUrl = (id: string) => `https://res.cloudinary.com/ecolink/image/upload/v1/captures/${id}.jpg`;
const galleryUrl = "https://res.cloudinary.com/ecolink/image/upload/v1/uploads/x.jpg";

const resolve = (userId: string, images: { url: string; captureId: string | null }[]) =>
  prisma.$transaction((tx) => resolveCaptureSources(tx, userId, images, new Date()));

describe("[it] camera captures (P03)", () => {
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
  });

  it("issues a 15-minute capture signed for captures/<id> only", async () => {
    const userId = randomUUID();
    const before = Date.now();
    const out = await issueCapture(userId);

    const row = await prisma.mediaCapture.findUniqueOrThrow({ where: { id: out.captureId } });
    expect(row.userId).toBe(userId);
    expect(Math.abs(row.expiresAt.getTime() - (before + 15 * 60_000))).toBeLessThan(5_000);
    expect(out.upload.publicId).toBe(`captures/${out.captureId}`);
    expect(out.upload.signature).toBe(
      cloudinary.utils.api_sign_request({ public_id: out.upload.publicId, timestamp: out.upload.timestamp }, "s"),
    );
  });

  it("consumes a valid capture once", async () => {
    const userId = randomUUID();
    const { captureId } = await issueCapture(userId);
    expect(await resolve(userId, [{ url: captureUrl(captureId), captureId }])).toEqual([{ captureSource: "LIVE", captureId }]);
    expect((await prisma.mediaCapture.findUniqueOrThrow({ where: { id: captureId } })).usedAt).toBeInstanceOf(Date);
    expect(await resolve(userId, [{ url: captureUrl(captureId), captureId }])).toEqual([{ captureSource: "GALLERY", captureId: null }]);
  });

  it("treats expired, foreign-user and wrong-folder captures as gallery", async () => {
    const userId = randomUUID();
    const expired = await prisma.mediaCapture.create({ data: { userId, expiresAt: new Date(Date.now() - 1000) } });
    expect((await resolve(userId, [{ url: captureUrl(expired.id), captureId: expired.id }]))[0].captureSource).toBe("GALLERY");

    const { captureId: foreign } = await issueCapture(randomUUID());
    expect((await resolve(userId, [{ url: captureUrl(foreign), captureId: foreign }]))[0].captureSource).toBe("GALLERY");
    expect((await prisma.mediaCapture.findUniqueOrThrow({ where: { id: foreign } })).usedAt).toBeNull();

    const { captureId } = await issueCapture(userId);
    expect((await resolve(userId, [{ url: galleryUrl, captureId }]))[0].captureSource).toBe("GALLERY");
    expect((await prisma.mediaCapture.findUniqueOrThrow({ where: { id: captureId } })).usedAt).toBeNull();
  });

  it("one capture makes at most one live image in a request", async () => {
    const userId = randomUUID();
    const { captureId } = await issueCapture(userId);
    const out = await resolve(userId, [
      { url: captureUrl(captureId), captureId },
      { url: captureUrl(captureId), captureId },
    ]);
    expect(out.map((o) => o.captureSource)).toEqual(["LIVE", "GALLERY"]);
  });

  it("createReport stores LIVE and GALLERY per image", async () => {
    const userId = randomUUID();
    const { captureId } = await issueCapture(userId);
    const { report } = await reportService.createReport(userId, {
      title: "Rác ven kênh",
      latitude: 10.79,
      longitude: 106.68,
      category: "WATERWAY",
      wasteTypes: ["HOUSEHOLD"],
      images: [{ url: captureUrl(captureId), captureId }, { url: galleryUrl }],
    });

    const files = await prisma.reportMediaFile.findMany({
      where: { reportId: report.id },
      include: { media: { select: { url: true } } },
    });
    const byUrl = new Map(files.map((f) => [f.media.url, f]));
    expect(byUrl.get(captureUrl(captureId))).toMatchObject({ captureSource: "LIVE", captureId });
    expect(byUrl.get(galleryUrl)).toMatchObject({ captureSource: "GALLERY", captureId: null });
  });
});
