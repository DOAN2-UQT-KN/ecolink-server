/**
 * Result verification in 3 layers (spec "Cơ chế xác thực kết quả chiến dịch", version 2: the vote
 * and the decision are per meeting point), against a real Postgres.
 *
 *   - Layer 1: result photos uploaded through the API (multipart, EXIF read on the server,
 *     Cloudinary mocked) are graded at once; the trash point's Layer 1 shows on the shift result
 *   - marking done opens a 72 h round per meeting point holding a trash point declared cleaned
 *     (none for a meeting point only partly done); its reporters are asked first, once each
 *   - the reporter and two residents on site verify the meeting point (10 + 3 + 3), the campaign
 *     completes; a reporter of two trash points of it still has one vote weighing 10
 *   - a downvote names the trash points not clean; with a score ≤ 3 it flags the meeting point; the
 *     admin rejects it naming the trash points that did not pass: the campaign is REJECTED and only
 *     the shifts that submitted those reopen; marking done again opens round 2 for it only
 *   - the sweep closes windows by Layer 1 (the worst trash point), rejects flags left for 48 h,
 *     reminds the reporters once
 *   - the organization's members, managers and volunteers cannot vote; 20 new votes a day; a new
 *     account weighs 0; on site = near the meeting point or one of its trash points
 *   - after 3 rejections the admin decides instead
 *
 * identity, reward and notification clients are mocked; the DB is real. Time is passed in.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "it-verification-secret";

import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Prisma } from "@prisma/client";
import express from "express";
import jwt from "jsonwebtoken";
import { prisma } from "./setup/test-db";
import { allowResultPhotos } from "./setup/result-photos";
import { jpegWithExif } from "./setup/jpeg-exif";

const DAY_MS = 24 * 60 * 60 * 1000;
/** userId → account; anyone else is 30 days old with a verified email and no saved location. */
const mockProfiles = new Map<string, { createdAt: Date; emailVerified: boolean; savedLocationDistanceM: number | null }>();

jest.mock("../modules/organization/identity-user.client", () => ({
  fetchOrganizationOwnersByUserIds: async () => new Map(),
  getUserProfile: () => undefined,
  fetchUserIdsNearPoint: async () => [],
  fetchUserVoteProfile: async ({ userId }: { userId: string }) =>
    mockProfiles.get(userId) ?? {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      emailVerified: true,
      savedLocationDistanceM: null,
    },
}));
jest.mock("../modules/reward/reward-service.client", () => {
  const tier = async (level: number) => ({ level, maxVolunteers: 20, suggestedMinVolunteers: 10, greenPoints: level * 10 });
  return {
    rewardServiceClient: { getDifficultyByLevel: tier, getDifficultyByLevelStrict: tier, getDifficulties: async () => [] },
  };
});
jest.mock("../queue/register", () => ({
  backgroundJobDispatcher: {
    dispatch: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("../modules/campaign/nearby-users", () => ({
  findNearbyUserIds: jest.fn().mockResolvedValue([]),
}));
jest.mock("../modules/campaign/notification-jobs.client", () => ({
  enqueueWebsiteNotificationsToUsers: jest.fn().mockResolvedValue(undefined),
  enqueueWebsiteNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../modules/campaign/campaign_shift_result/result-photo.storage", () => ({
  resultPhotoStorage: {
    upload: jest.fn(
      async () => `https://res.cloudinary.com/demo/image/upload/${require("node:crypto").randomUUID()}.jpg`,
    ),
  },
}));

import { CampaignStatus } from "@da2/constants";
import { ReportStatus } from "../constants/status.enum";
import { OutboxEventType } from "../outbox/outbox.types";
import { camelCaseRequestBody, snakeCaseResponseBody } from "../middleware/case-transform.middleware";
import campaignRoutes from "../modules/campaign/campaign.routes";
import { campaignService } from "../modules/campaign/campaign.service";
import { shiftResultService } from "../modules/campaign/campaign_shift_result/shift-result.service";
import { campaignVerificationService as verification } from "../modules/campaign/campaign_verification/verification.service";
import { runResultVerificationSweep } from "../modules/campaign/campaign_verification/verification-jobs";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const OWNER = randomUUID();
const MGR = randomUUID();
const ADMIN = randomUUID();
const V1 = randomUUID();
const REPORTER = randomUUID();
const POINT = { latitude: 10.77, longitude: 106.7 };
/** ~55 m from POINT: a pin within 100 m. */
const NEAR = { latitude: 10.7705, longitude: 106.7 };
const IMG_BEFORE = "https://res.cloudinary.com/demo/image/upload/before.jpg";
const IMG_AFTER = "https://res.cloudinary.com/demo/image/upload/after.jpg";

const code = (c: string) => ({ statusResponse: expect.objectContaining({ code: c }) });
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

type Level = "pass" | "warn" | "fail";
type PointStatus = "cleaned" | "partial";
type Rk = "r1" | "r2" | "r3" | "r4";

/**
 * A running campaign whose shifts ended an hour ago: meeting point A has R1 and R4 (both reported
 * by REPORTER), meeting point B has R2 and R3 (no reporter). Shift A submits R1 and R4; shift B
 * submits R2 and R3, or with `splitB` shift B submits R2 and a second shift B2 submits R3. V1
 * registered and attended every shift. Each report gets a photo before and after graded
 * `levels[rk]` (pass by default) and declared `statuses[rk]` (R1 cleaned, the others partly done
 * by default).
 */
async function seed(
  opts: { statuses?: Partial<Record<Rk, PointStatus>>; levels?: Partial<Record<Rk, Level>>; splitB?: boolean } = {},
) {
  const statusOf = (k: Rk) => opts.statuses?.[k] ?? (k === "r1" ? "cleaned" : "partial");
  const levelOf = (k: Rk) => opts.levels?.[k] ?? "pass";
  const start = new Date(Date.now() - 5 * HOUR);
  const end = at(start, 4 * HOUR);
  const org = await prisma.organization.create({
    data: {
      name: `Org ${randomUUID()}`,
      slug: `org-${randomUUID()}`,
      logoUrl: "https://example.com/logo.png",
      status: 1,
      members: {
        create: [
          { userId: OWNER, role: "OWNER", source: "INTERNAL" },
          { userId: MGR, role: "CAMPAIGN_MANAGER", source: "INTERNAL" },
        ],
      },
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      title: "Dọn rác kênh",
      status: CampaignStatus.ACTIVE,
      organizationId: org.id,
      createdBy: OWNER,
      difficulty: 1,
      approvedAt: start,
      ...POINT,
      campaignManagers: { create: [{ userId: OWNER, assignedBy: OWNER }, { userId: MGR, assignedBy: OWNER }] },
    },
  });
  const day = await prisma.campaignDay.create({ data: { campaignId: campaign.id, startAt: start, endAt: end } });
  const [pa, pb] = await Promise.all(
    [0, 1].map((i) =>
      prisma.campaignMeetingPoint.create({
        data: { campaignId: campaign.id, ...POINT, radiusKm: 1, sortOrder: i },
      }),
    ),
  );
  const report = (title: string, userId: string | null) =>
    prisma.report.create({
      data: { title, userId, ...POINT, status: ReportStatus._STATUS_INPROCESS, isVerify: true, campaignId: campaign.id },
    });
  const r1 = await report("R1", REPORTER);
  const r2 = await report("R2", null);
  const r3 = await report("R3", null);
  const r4 = await report("R4", REPORTER);
  await prisma.campaignMeetingPointReport.createMany({
    // Linked in this order (R1, R2, R3, R4), so the campaign's order is stable.
    data: [
      { campaignId: campaign.id, meetingPointId: pa.id, reportId: r1.id },
      { campaignId: campaign.id, meetingPointId: pb.id, reportId: r2.id },
      { campaignId: campaign.id, meetingPointId: pb.id, reportId: r3.id },
      { campaignId: campaign.id, meetingPointId: pa.id, reportId: r4.id },
    ].map((l, i) => ({ ...l, createdAt: at(start, i * 1000) })),
  });
  const shift = (meetingPointId: string, dayId = day.id, from = start, to = end) =>
    prisma.campaignShift.create({
      data: { campaignId: campaign.id, dayId, meetingPointId, startAt: from, endAt: to, minVolunteers: 5, leaderUserId: MGR },
    });
  const a = await shift(pa.id);
  const b = await shift(pb.id);
  // One shift per meeting point and day: B2 is the day before.
  let b2 = b;
  if (opts.splitB) {
    const before = { startAt: at(start, -DAY_MS), endAt: at(end, -DAY_MS) };
    const day0 = await prisma.campaignDay.create({ data: { campaignId: campaign.id, ...before } });
    b2 = await shift(pb.id, day0.id, before.startAt, before.endAt);
  }
  const shifts = [...new Set([a, b, b2])];
  await prisma.campaignShiftRegistration.createMany({
    data: shifts.map((s) => ({ campaignId: campaign.id, shiftId: s.id, userId: V1 })),
  });
  await prisma.campaignShiftAttendance.createMany({
    data: shifts.map((s) => ({ campaignId: campaign.id, shiftId: s.id, userId: V1, checkInAt: s.startAt, checkOutAt: s.endAt, preRegistered: true })),
  });
  const keys: Rk[] = ["r1", "r2", "r3", "r4"];
  const ids: Record<Rk, string> = { r1: r1.id, r2: r2.id, r3: r3.id, r4: r4.id };
  const shiftOf: Record<Rk, { id: string }> = { r1: a, r2: b, r3: b2, r4: a };
  const photo = (k: Rk) => ({
    reportId: ids[k],
    status: statusOf(k),
    beforeUrls: [`${IMG_BEFORE}?r=${k}`],
    afterUrls: [`${IMG_AFTER}?r=${k}`],
  });
  await allowResultPhotos(
    keys.flatMap((k) => [
      { campaignId: campaign.id, shiftId: shiftOf[k].id, reportId: ids[k], url: photo(k).beforeUrls[0], sides: ["before" as const], level: levelOf(k), exifTakenAt: at(start, 10 * MIN) },
      { campaignId: campaign.id, shiftId: shiftOf[k].id, reportId: ids[k], url: photo(k).afterUrls[0], sides: ["after" as const], level: levelOf(k), exifTakenAt: at(start, 3 * HOUR) },
    ]),
  );
  await shiftResultService.save(campaign.id, a.id, MGR, { description: "Điểm A", reports: [photo("r1"), photo("r4")], mediaIds: [] });
  if (opts.splitB) {
    await shiftResultService.save(campaign.id, b.id, MGR, { description: "Điểm B ca 1", reports: [photo("r2")], mediaIds: [] });
    await shiftResultService.save(campaign.id, b2.id, MGR, { description: "Điểm B ca 2", reports: [photo("r3")], mediaIds: [] });
  } else {
    await shiftResultService.save(campaign.id, b.id, MGR, { description: "Điểm B", reports: [photo("r2"), photo("r3")], mediaIds: [] });
  }
  return { id: campaign.id, orgId: org.id, start, a, b, b2, pa: pa.id, pb: pb.id, ...ids };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

const markDone = (c: Seeded, now = new Date()) => campaignService.submitCampaignCompletion(c.id, OWNER, undefined, [], now);

const onSite = { latitude: POINT.latitude, longitude: POINT.longitude, accuracy: 5 };
const vote = (
  c: Seeded,
  meetingPointId: string,
  userId: string,
  value: "up" | "down",
  extra: Partial<Parameters<typeof verification.vote>[3]> = {},
  now?: Date,
) => verification.vote(c.id, meetingPointId, { userId }, { value, ...extra }, now);

async function notices(campaignId: string) {
  const rows = await prisma.outboxEvent.findMany({
    where: { aggregateId: campaignId, eventType: OutboxEventType.WEBSITE_NOTIFICATION },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => r.payload as { kind: string; userIds: string[]; payload: Record<string, string> });
}
const kinds = async (campaignId: string) => (await notices(campaignId)).map((n) => n.kind);
const status = async (id: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id } })).status;
const round = (campaignId: string, meetingPointId: string) =>
  prisma.meetingPointVerification.findFirstOrThrow({ where: { campaignId, meetingPointId }, orderBy: { round: "desc" } });

beforeAll(() => {
  process.env.CAMPAIGN_ADMIN_NOTIFY_USER_IDS = ADMIN;
});

beforeEach(async () => {
  await prisma.$executeRaw(
    Prisma.sql`TRUNCATE TABLE "organizations", "campaigns", "reports", "outbox_events" RESTART IDENTITY CASCADE`,
  );
  mockProfiles.clear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Layer 1: uploading result photos", () => {
  let server: ReturnType<express.Application["listen"]>;
  let base: string;
  const token = (userId: string, role = "user") =>
    jwt.sign({ userId, email: `${userId}@x.dev`, role }, process.env.JWT_SECRET!);

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(camelCaseRequestBody);
    app.use(snakeCaseResponseBody);
    app.use("/api/v1/campaigns", campaignRoutes);
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/campaigns`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  /** EXIF local time (Vietnam) of `d`. */
  const exifTime = (d: Date) => new Date(d.getTime() + 7 * HOUR).toISOString().slice(0, 19).replace(/-/g, ":").replace("T", " ");

  const upload = async (
    c: Seeded,
    file: Buffer | null,
    fields: Record<string, string>,
    userId = MGR,
  ) => {
    const form = new FormData();
    if (file) form.append("file", new Blob([file], { type: "image/jpeg" }), "photo.jpg");
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await fetch(`${base}/${c.id}/shifts/${c.a.id}/result-photos`, {
      method: "POST",
      headers: { authorization: `Bearer ${token(userId)}` },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it("grades a photo with EXIF, a photo without, a far pin; refuses what is not a photo", async () => {
    const c = await seed();
    const pin = { report_id: c.r1, pin_lat: String(NEAR.latitude), pin_lng: String(NEAR.longitude) };
    const taken = new Date(Date.now() - 2 * HOUR);
    const withExif = await upload(
      c,
      jpegWithExif({ takenAt: exifTime(taken), latitude: NEAR.latitude, longitude: NEAR.longitude, model: "Pixel 8", seed: "1" }),
      { ...pin, side: "before" },
    );
    expect(withExif.status).toBe(200);
    expect(withExif.body.data).toMatchObject({
      url: expect.stringMatching(/^https:\/\/res\.cloudinary\.com\//),
      check: {
        side: "before",
        level: "pass",
        time_check: "pass",
        exif_location_check: "pass",
        pin_check: "pass",
        camera_model: "Pixel 8",
        exif_taken_at: new Date(Math.floor(taken.getTime() / 1000) * 1000).toISOString(),
      },
    });

    const bare = await upload(c, jpegWithExif({ seed: "2" }), { ...pin, side: "after" });
    expect(bare.body.data.check).toMatchObject({ level: "warn", time_check: "warn", exif_location_check: "warn", pin_check: "pass" });

    const far = await upload(c, jpegWithExif({ seed: "3" }), { ...pin, pin_lat: "10.79", side: "after" });
    expect(far.body.data.check).toMatchObject({ level: "fail", pin_check: "fail" });

    expect((await upload(c, Buffer.from("not an image"), { ...pin, side: "after" })).body).toMatchObject({
      code: "RESULT_PHOTO_INVALID",
    });
    expect((await upload(c, null, { ...pin, side: "after" })).body.code).toBe("RESULT_PHOTO_INVALID");
    expect((await upload(c, jpegWithExif({ seed: "4" }), { ...pin, side: "middle" })).status).toBe(422);
    expect((await upload(c, jpegWithExif({ seed: "5" }), { ...pin, side: "after" }, V1)).body.code).toBe(
      "CAMPAIGN_PERMISSION_DENIED",
    );
    expect(
      (await upload(c, jpegWithExif({ seed: "6" }), { ...pin, report_id: c.r2, side: "after" })).body.code,
    ).toBe("SHIFT_RESULT_INVALID");

    // The uploaded photos go into the result; its Layer 1 shows at once.
    const saved = await shiftResultService.save(c.id, c.a.id, MGR, {
      description: "Điểm A",
      reports: [{ reportId: c.r1, status: "cleaned", beforeUrls: [withExif.body.data.url], afterUrls: [bare.body.data.url] }],
      mediaIds: [],
    });
    expect(saved.result?.reports[0].layer1).toMatchObject({
      level: "warn",
      issues: [{ code: "photo_warn", side: "after", url: bare.body.data.url }],
    });
    expect(saved.result?.reports[0].layer1?.photos.map((p) => p.check?.level)).toEqual(["pass", "warn"]);
  });

  it("fails the same file before and after, and a file reused for another trash point", async () => {
    const c = await seed({ statuses: { r2: "cleaned" } });
    const file = jpegWithExif({ seed: "same" });
    const pin = { pin_lat: String(NEAR.latitude), pin_lng: String(NEAR.longitude) };
    const before = await upload(c, file, { ...pin, report_id: c.r1, side: "before" });
    const after = await upload(c, file, { ...pin, report_id: c.r1, side: "after" });
    const saved = await shiftResultService.save(c.id, c.a.id, MGR, {
      description: "Điểm A",
      reports: [{ reportId: c.r1, status: "cleaned", beforeUrls: [before.body.data.url], afterUrls: [after.body.data.url] }],
      mediaIds: [],
    });
    expect(saved.result?.reports[0].layer1?.level).toBe("fail");
    expect(saved.result?.reports[0].layer1?.issues.map((i) => i.code)).toContain("before_after_same");

    // The same file pinned for R2 on shift B: both points are flagged as reused.
    const form = new FormData();
    form.append("file", new Blob([file], { type: "image/jpeg" }), "p.jpg");
    for (const [k, v] of Object.entries({ ...pin, report_id: c.r2, side: "after" })) form.append(k, v);
    const res = await fetch(`${base}/${c.id}/shifts/${c.b.id}/result-photos`, {
      method: "POST",
      headers: { authorization: `Bearer ${token(MGR)}` },
      body: form,
    });
    const reused = ((await res.json()) as { data: { url: string } }).data.url;
    const b = await shiftResultService.save(c.id, c.b.id, MGR, {
      description: "Điểm B",
      reports: [{ reportId: c.r2, status: "cleaned", beforeUrls: [], afterUrls: [reused] }],
      mediaIds: [],
    });
    expect(b.result?.reports[0].layer1?.issues.map((i) => i.code)).toContain("hash_reused");
  });

  it("serves the verification page in snake_case; a downvote needs report_ids", async () => {
    const c = await seed();
    await markDone(c);
    const res = await fetch(`${base}/${c.id}/verification`, { headers: { authorization: `Bearer ${token(randomUUID())}` } });
    const body = (await res.json()) as { data: Record<string, any> };
    expect(body.data).toMatchObject({
      campaign_id: c.id,
      awaiting_admin: false,
      can_see_votes: false,
      cannot_vote_reason: null,
      meeting_points: [
        {
          meeting_point_id: c.pa,
          name: null,
          latitude: POINT.latitude,
          longitude: POINT.longitude,
          round: 1,
          status: "voting",
          layer1_level: "pass",
          failed_report_ids: [],
          can_vote: true,
          cannot_vote_reason: null,
          is_reporter: false,
          my_vote: null,
          up_count: 0,
          down_count: 0,
          score: null,
          votes: null,
          trash_points: [
            { report_id: c.r1, status: "cleaned", is_mine: false, layer1: { level: "pass", issues: [] } },
            { report_id: c.r4, status: "partial", is_mine: false, layer1: null },
          ],
        },
      ],
    });
    expect(body.data.meeting_points).toHaveLength(1);

    const put = (payload: object) =>
      fetch(`${base}/${c.id}/verification/${c.pa}/vote`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token(randomUUID())}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    const missing = await put({ value: "down", note: "Còn rác" });
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as { code: string }).code).toBe("MEETING_POINT_VOTE_REPORTS_REQUIRED");
    const named = await put({ value: "down", note: "Còn rác", report_ids: [c.r1] });
    expect(named.status).toBe(200);
    expect(((await named.json()) as { data: Record<string, any> }).data).toMatchObject({
      meeting_point: { meeting_point_id: c.pa, down_count: 1, my_vote: { value: "down", flagged_report_ids: [c.r1] } },
      campaign_status: CampaignStatus.PENDING_COMPLETION,
    });

    const legacy = await fetch(`${base}/${c.id}/completion-verification`, {
      method: "POST",
      headers: { authorization: `Bearer ${token(randomUUID())}`, "content-type": "application/json" },
      body: JSON.stringify({ value: 1 }),
    });
    expect(legacy.status).toBe(410);
  });
});

describe("voting", () => {
  it("marking done opens a round per meeting point with a cleaned trash point and asks the reporter first", async () => {
    const c = await seed();
    const now = new Date();
    await markDone(c, now);
    const r = await round(c.id, c.pa);
    expect(r).toMatchObject({ round: 1, status: "voting", reportIds: [c.r1], reporterIds: [REPORTER], layer1Level: "pass", score: 0 });
    expect(r.windowEndsAt.getTime()).toBe(now.getTime() + 72 * HOUR);
    // Meeting point B: R2 and R3 only partly done, no round.
    expect(await prisma.meetingPointVerification.count({ where: { campaignId: c.id } })).toBe(1);
    const asked = (await notices(c.id)).filter((n) => n.kind === "CAMPAIGN_MEETING_POINT_CONFIRM_REQUEST");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      userIds: [REPORTER],
      payload: { meetingPointId: c.pa, meetingPointName: "#1", reportId: c.r1, reportTitle: "R1" },
    });
    expect(await kinds(c.id)).not.toContain("CAMPAIGN_COMPLETION_PENDING_ADMIN");
  });

  it("a reporter of two trash points of the meeting point is asked once and votes once, weighing 10", async () => {
    const c = await seed({ statuses: { r4: "cleaned" }, levels: { r4: "warn" } });
    await markDone(c);
    expect(await round(c.id, c.pa)).toMatchObject({ reportIds: [c.r1, c.r4], reporterIds: [REPORTER], layer1Level: "warn" });
    const asked = (await notices(c.id)).filter((n) => n.kind === "CAMPAIGN_MEETING_POINT_CONFIRM_REQUEST");
    expect(asked).toHaveLength(1);
    expect(asked[0].payload).toMatchObject({ reportTitle: "R1, R4" });
    const res = await vote(c, c.pa, REPORTER, "up");
    expect(res.meetingPoint).toMatchObject({
      isReporter: true,
      score: null,
      upCount: 1,
      myVote: { value: "up", weight: 10, weightReason: "reporter" },
    });
    expect(res.meetingPoint.trashPoints.map((t) => [t.reportId, t.isMine, t.layer1?.level])).toEqual([
      [c.r1, true, "pass"],
      [c.r4, true, "warn"],
    ]);
    expect(await round(c.id, c.pa)).toMatchObject({ score: 10 });
  });

  it("a vote can be taken back while the window is open; nothing to take back is a no-op", async () => {
    const c = await seed();
    await markDone(c);
    const neighbour = randomUUID();
    await vote(c, c.pa, REPORTER, "up");
    await vote(c, c.pa, neighbour, "up", onSite);
    expect(await round(c.id, c.pa)).toMatchObject({ score: 13 });

    const res = await verification.unvote(c.id, c.pa, { userId: REPORTER });
    expect(res.meetingPoint).toMatchObject({ upCount: 1, myVote: null, status: "voting" });
    expect(await round(c.id, c.pa)).toMatchObject({ score: 3 });
    // Again: no vote left, nothing changes.
    expect((await verification.unvote(c.id, c.pa, { userId: REPORTER })).meetingPoint).toMatchObject({ upCount: 1, myVote: null });

    await expect(verification.unvote(c.id, c.pa, { userId: neighbour }, at(new Date(), 73 * HOUR))).rejects.toMatchObject(
      code("MEETING_POINT_VOTE_CLOSED"),
    );
  });

  it("reporter + 2 residents on site verify the meeting point; the campaign completes", async () => {
    const c = await seed();
    await markDone(c);
    const [p1, p2] = [randomUUID(), randomUUID()];
    const first = await vote(c, c.pa, REPORTER, "up");
    expect(first.meetingPoint).toMatchObject({ isReporter: true, myVote: { value: "up", weight: 10, weightReason: "reporter" } });
    await vote(c, c.pa, p1, "up", onSite);
    expect(await status(c.id)).toBe(CampaignStatus.PENDING_COMPLETION);
    const last = await vote(c, c.pa, p2, "up", onSite);
    expect(last.meetingPoint).toMatchObject({ status: "verified", decisionCode: "score", canVote: false, cannotVoteReason: "closed" });
    expect(last.campaignStatus).toBe(CampaignStatus.COMPLETED);

    expect(await round(c.id, c.pa)).toMatchObject({ score: 16, status: "verified" });
    const reports = await prisma.report.findMany({ where: { id: { in: [c.r1, c.r2, c.r3, c.r4] } } });
    const byId = Object.fromEntries(reports.map((r) => [r.id, r]));
    expect(byId[c.r1]).toMatchObject({ status: ReportStatus._STATUS_COMPLETED, campaignId: c.id });
    expect(byId[c.r2]).toMatchObject({ status: ReportStatus._STATUS_TODO, campaignId: null });
    expect(byId[c.r4]).toMatchObject({ status: ReportStatus._STATUS_TODO, campaignId: null });
    expect(await kinds(c.id)).toEqual(expect.arrayContaining(["CAMPAIGN_DONE", "CAMPAIGN_RESULT_VERIFIED"]));
    const credits = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: c.id, eventType: OutboxEventType.CAMPAIGN_COMPLETION_GREEN_POINTS },
    });
    expect(credits.payload).toMatchObject({ credits: [{ userId: V1, points: 10 }] });
    const log = await prisma.campaignStatusLog.findFirstOrThrow({ where: { campaignId: c.id, event: "approve_completion" } });
    expect(log).toMatchObject({ actorRole: "system", actorId: null });
    // Too late to vote now.
    await expect(vote(c, c.pa, randomUUID(), "up")).rejects.toMatchObject(code("MEETING_POINT_VOTE_CLOSED"));
  });

  it("who may vote, how much it weighs, and the daily limit", async () => {
    const c = await seed();
    await markDone(c);
    const err = (reason: string) => ({ ...code("MEETING_POINT_VOTE_NOT_ALLOWED"), data: { reason } });
    await expect(vote(c, c.pa, OWNER, "up")).rejects.toMatchObject(err("campaign_manager"));
    await expect(vote(c, c.pa, MGR, "up")).rejects.toMatchObject(err("campaign_manager"));
    const member = randomUUID();
    await prisma.organizationMember.create({ data: { organizationId: c.orgId, userId: member, role: "MEMBER", source: "INTERNAL" } });
    await expect(vote(c, c.pa, member, "up")).rejects.toMatchObject(err("org_member"));
    await expect(vote(c, c.pa, V1, "up")).rejects.toMatchObject(err("volunteer"));
    const outsider = randomUUID();
    await expect(vote(c, c.pa, outsider, "down", { reportIds: [c.r1] })).rejects.toMatchObject(
      code("MEETING_POINT_VOTE_REASON_REQUIRED"),
    );
    await expect(vote(c, c.pa, outsider, "down", { note: "Còn rác" })).rejects.toMatchObject(
      code("MEETING_POINT_VOTE_REPORTS_REQUIRED"),
    );
    // R4 is only partly done (not part of the vote); R2 belongs to meeting point B.
    for (const reportIds of [[c.r4], [c.r1, c.r2]]) {
      await expect(vote(c, c.pa, outsider, "down", { note: "Còn rác", reportIds })).rejects.toMatchObject(
        code("MEETING_POINT_VOTE_REPORTS_REQUIRED"),
      );
    }
    await expect(vote(c, c.pb, outsider, "up")).rejects.toMatchObject(code("NOT_FOUND"));

    const newbie = randomUUID();
    mockProfiles.set(newbie, { createdAt: new Date(Date.now() - DAY_MS), emailVerified: true, savedLocationDistanceM: null });
    const unverified = randomUUID();
    mockProfiles.set(unverified, { createdAt: new Date(Date.now() - 30 * DAY_MS), emailVerified: false, savedLocationDistanceM: 10 });
    const neighbour = randomUUID();
    mockProfiles.set(neighbour, { createdAt: new Date(Date.now() - 30 * DAY_MS), emailVerified: true, savedLocationDistanceM: 2000 });
    expect((await vote(c, c.pa, newbie, "up", onSite)).meetingPoint.myVote).toMatchObject({ weight: 0, weightReason: "zero_new_account" });
    expect((await vote(c, c.pa, unverified, "up", onSite)).meetingPoint.myVote).toMatchObject({ weight: 0, weightReason: "zero_unverified" });
    expect((await vote(c, c.pa, neighbour, "up")).meetingPoint.myVote).toMatchObject({ weight: 1, weightReason: "nearby" });
    expect((await vote(c, c.pa, outsider, "up")).meetingPoint.myVote).toMatchObject({ weight: 0, weightReason: "zero_far" });
    // Changing a vote keeps the best weight: on site first, then from home.
    const walker = randomUUID();
    await vote(c, c.pa, walker, "up", onSite);
    expect((await vote(c, c.pa, walker, "up")).meetingPoint.myVote).toMatchObject({ weight: 3, weightReason: "on_site" });
    // On site = near the meeting point OR one of its trash points: the meeting point moved ~3 km
    // away, the voter stands at R1.
    await prisma.campaignMeetingPoint.update({ where: { id: c.pa }, data: { latitude: POINT.latitude + 0.03 } });
    const atTrash = randomUUID();
    expect((await vote(c, c.pa, atTrash, "up", onSite)).meetingPoint.myVote).toMatchObject({ weight: 3, weightReason: "on_site" });

    // Managers see every vote, zero-weight ones too; residents see counts only.
    const managerView = await verification.getView(c.id, { userId: MGR });
    expect(managerView).toMatchObject({ canSeeVotes: true, cannotVoteReason: "campaign_manager" });
    expect(managerView.meetingPoints[0]).toMatchObject({ score: 7, upCount: 6, downCount: 0 });
    expect(managerView.meetingPoints[0].votes?.map((v) => v.weight).sort()).toEqual([0, 0, 0, 1, 3, 3]);
    const residentView = await verification.getView(c.id, { userId: randomUUID() });
    expect(residentView.meetingPoints[0]).toMatchObject({ score: null, votes: null, upCount: 6, canVote: true });

    // 20 new votes a day across the platform; changing one is free.
    const others = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        prisma.meetingPointVerification.create({
          data: {
            campaignId: c.id,
            meetingPointId: c.pb,
            round: i + 1,
            status: "voting",
            reportIds: [],
            layer1Level: "pass",
            windowEndsAt: at(new Date(), 72 * HOUR),
          },
        }),
      ),
    );
    const busy = (userId: string, count: number) =>
      prisma.meetingPointVote.createMany({
        data: others.slice(0, count).map((o) => ({ verificationId: o.id, userId, value: 1, weight: 0, weightReason: "zero_far" })),
      });
    const limited = randomUUID();
    await busy(limited, 20);
    await expect(vote(c, c.pa, limited, "up")).rejects.toMatchObject(code("MEETING_POINT_VOTE_LIMIT"));
    const changer = randomUUID();
    await busy(changer, 19);
    await vote(c, c.pa, changer, "up"); // the 20th
    expect(
      (await vote(c, c.pa, changer, "down", { note: "Nhìn kỹ thì còn rác", reportIds: [c.r1] })).meetingPoint.myVote,
    ).toMatchObject({ value: "down", flaggedReportIds: [c.r1] });
  });
});

describe("flags, the admin and resubmitting", () => {
  it("a downvote at ≤ 3 flags; the admin rejects: REJECTED, only the shift with the failed trash point reopens; round 2 for that meeting point only", async () => {
    const c = await seed({ statuses: { r2: "cleaned", r3: "cleaned" }, splitB: true });
    await markDone(c);
    expect(await round(c.id, c.pb)).toMatchObject({ reportIds: [c.r2, c.r3], reporterIds: [] });
    // No reporter in meeting point B: nobody is asked (Layer 2 skipped).
    const asked = (await notices(c.id)).filter((n) => n.kind === "CAMPAIGN_MEETING_POINT_CONFIRM_REQUEST");
    expect(asked.map((n) => n.payload.meetingPointId)).toEqual([c.pa]);
    // A verified by votes.
    await vote(c, c.pa, REPORTER, "up");
    await vote(c, c.pa, randomUUID(), "up", onSite);
    await vote(c, c.pa, randomUUID(), "up", onSite);
    // B flagged by a nearby resident pointing at R2.
    const neighbour = randomUUID();
    mockProfiles.set(neighbour, { createdAt: new Date(Date.now() - 30 * DAY_MS), emailVerified: true, savedLocationDistanceM: 1500 });
    const flagged = await vote(c, c.pb, neighbour, "down", {
      note: "Vẫn còn rác",
      photoUrl: "https://res.cloudinary.com/demo/x.jpg",
      reportIds: [c.r2],
    });
    expect(flagged.meetingPoint).toMatchObject({ status: "flagged", canVote: true });
    expect(flagged.meetingPoint.flagDeadline).not.toBeNull();
    expect(flagged.campaignStatus).toBe(CampaignStatus.PENDING_COMPLETION);
    expect((await notices(c.id)).find((n) => n.kind === "CAMPAIGN_MEETING_POINT_FLAGGED")).toMatchObject({
      userIds: [ADMIN],
      payload: { meetingPointId: c.pb, meetingPointName: "#2" },
    });
    const adminView = await verification.getView(c.id, { userId: ADMIN, role: "admin" });
    expect(adminView.meetingPoints[1].votes).toEqual([
      expect.objectContaining({ value: "down", weight: 1, flaggedReportIds: [c.r2], note: "Vẫn còn rác" }),
    ]);

    await expect(verification.decide(c.id, c.pa, ADMIN, { decision: "reject", reason: "x", reportIds: [c.r1] })).rejects.toMatchObject(
      code("MEETING_POINT_NOT_FLAGGED"),
    );
    await expect(verification.decide(c.id, c.pb, ADMIN, { decision: "reject", reportIds: [c.r2] })).rejects.toMatchObject(
      code("VALIDATION_ERROR"),
    );
    await expect(verification.decide(c.id, c.pb, ADMIN, { decision: "reject", reason: "x" })).rejects.toMatchObject(
      code("MEETING_POINT_REJECT_REPORTS_REQUIRED"),
    );
    await expect(
      verification.decide(c.id, c.pb, ADMIN, { decision: "reject", reason: "x", reportIds: [c.r1] }),
    ).rejects.toMatchObject(code("MEETING_POINT_REJECT_REPORTS_REQUIRED"));
    const decided = await verification.decide(c.id, c.pb, ADMIN, {
      decision: "reject",
      reason: "Ảnh sau chụp chỗ khác",
      reportIds: [c.r2],
    });
    expect(decided.meetingPoint).toMatchObject({
      status: "rejected",
      decisionCode: "admin",
      decisionReason: "Ảnh sau chụp chỗ khác",
      failedReportIds: [c.r2],
    });
    expect(decided.campaignStatus).toBe(CampaignStatus.ACTIVE);

    const reason = "#2 (R2): Ảnh sau chụp chỗ khác";
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(campaign).toMatchObject({ completionRejectionCount: 1, rejectReason: reason });
    const results = await prisma.campaignShiftResult.findMany({ where: { campaignId: c.id } });
    expect(results.find((r) => r.shiftId === c.b.id)).toMatchObject({ reopenReason: reason });
    // B2 submitted only R3, which passed: not reopened. A was verified.
    expect(results.find((r) => r.shiftId === c.b2.id)?.reopenedAt).toBeNull();
    expect(results.find((r) => r.shiftId === c.a.id)?.reopenedAt).toBeNull();
    expect(await kinds(c.id)).toEqual(expect.arrayContaining(["CAMPAIGN_MEETING_POINT_REJECTED", "CAMPAIGN_RESULT_REJECTED"]));
    expect((await notices(c.id)).find((n) => n.kind === "CAMPAIGN_MEETING_POINT_REJECTED")?.payload).toMatchObject({
      meetingPointId: c.pb,
      reason: "Ảnh sau chụp chỗ khác",
      failedReports: "R2",
    });
    const rejectedNotice = (await notices(c.id)).find((n) => n.kind === "CAMPAIGN_RESULT_REJECTED");
    expect(rejectedNotice?.userIds).toEqual(expect.arrayContaining([OWNER, MGR]));
    expect(rejectedNotice?.payload.reasons).toBe(reason);

    // Shift B saved again with new photos, the campaign marked done again: round 2 for B only.
    const fresh = "https://res.cloudinary.com/demo/image/upload/fresh.jpg";
    await allowResultPhotos([{ campaignId: c.id, shiftId: c.b.id, reportId: c.r2, url: fresh, sides: ["after"] }]);
    await shiftResultService.save(c.id, c.b.id, MGR, {
      description: "Làm lại điểm B",
      reports: [{ reportId: c.r2, status: "cleaned", beforeUrls: [], afterUrls: [fresh] }],
      mediaIds: [],
    });
    await markDone(c);
    expect(await round(c.id, c.pa)).toMatchObject({ round: 1, status: "verified" });
    const second = await round(c.id, c.pb);
    expect(second).toMatchObject({ round: 2, status: "voting", reportIds: [c.r2, c.r3] });
    expect((second.layer1 as Array<{ reportId: string; afterUrls: string[] }>).find((e) => e.reportId === c.r2)?.afterUrls).toEqual([fresh]);
    for (let i = 0; i < 5; i++) await vote(c, c.pb, randomUUID(), "up", onSite);
    expect(await status(c.id)).toBe(CampaignStatus.COMPLETED);
  });

  it("after 3 rejections a 4th hands the campaign to the admin", async () => {
    const c = await seed();
    await prisma.campaign.update({ where: { id: c.id }, data: { completionRejectionCount: 3 } });
    await markDone(c);
    await vote(c, c.pa, REPORTER, "down", { note: "Chưa dọn", reportIds: [c.r1] });
    const res = await verification.decide(c.id, c.pa, ADMIN, { decision: "reject", reason: "Chưa dọn", reportIds: [c.r1] });
    expect(res.campaignStatus).toBe(CampaignStatus.PENDING_COMPLETION);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(campaign).toMatchObject({ completionAwaitingAdmin: true, completionRejectionCount: 3 });
    expect((await notices(c.id)).find((n) => n.kind === "CAMPAIGN_COMPLETION_PENDING_ADMIN")).toMatchObject({
      userIds: [ADMIN],
      payload: { reason: "rejection_limit" },
    });
    const view = await verification.getView(c.id, { userId: ADMIN, role: "admin" });
    expect(view).toMatchObject({ awaitingAdmin: true, awaitingAdminReason: "rejection_limit", canDecide: true });
  });
});

describe("the sweep", () => {
  it("closes windows by Layer 1 (the worst trash point); a Layer 1 fail rejects with the failed trash points", async () => {
    const c = await seed({ statuses: { r2: "cleaned", r3: "cleaned" }, levels: { r2: "warn", r3: "fail" } });
    const now = new Date();
    await markDone(c, now);
    expect(await round(c.id, c.pb)).toMatchObject({ layer1Level: "fail" });
    expect(await runResultVerificationSweep(at(now, 71 * HOUR))).toMatchObject({ closed: 0 });

    expect(await runResultVerificationSweep(at(now, 73 * HOUR))).toMatchObject({ closed: 2, decided: 1 });
    expect(await round(c.id, c.pa)).toMatchObject({ status: "verified", decisionCode: "layer1_pass" });
    expect(await round(c.id, c.pb)).toMatchObject({
      status: "rejected",
      decisionCode: "layer1_fail",
      decisionReason: "Ảnh không đạt kiểm tra tự động (Layer 1)",
      failedReportIds: [c.r3],
    });
    expect(await status(c.id)).toBe(CampaignStatus.ACTIVE);
    const shiftB = await prisma.campaignShiftResult.findUniqueOrThrow({ where: { shiftId: c.b.id } });
    expect(shiftB.reopenReason).toBe("#2 (R3): Ảnh không đạt kiểm tra tự động (Layer 1)");
  });

  it("Layer 1 warning flags; a flag left 48 h is rejected with the trash points weighted downvotes named", async () => {
    const c = await seed({ statuses: { r4: "cleaned", r2: "cleaned" }, levels: { r4: "warn" } });
    const now = new Date();
    await markDone(c, now);
    // B: a nearby resident says R2 is not clean (R3 is only partly done, not in the round).
    const neighbour = randomUUID();
    mockProfiles.set(neighbour, { createdAt: new Date(Date.now() - 30 * DAY_MS), emailVerified: true, savedLocationDistanceM: 100 });
    await vote(c, c.pb, neighbour, "down", { note: "Còn rác", reportIds: [c.r2] }, at(now, HOUR));
    expect(await round(c.id, c.pb)).toMatchObject({ status: "flagged", reportIds: [c.r2] });

    // B was flagged an hour in: its 48 h end first; A still votes, so the campaign waits.
    expect(await runResultVerificationSweep(at(now, 48 * HOUR))).toMatchObject({ expiredFlags: 0 });
    expect(await runResultVerificationSweep(at(now, 50 * HOUR))).toMatchObject({ expiredFlags: 1, decided: 0 });
    expect(await round(c.id, c.pb)).toMatchObject({ status: "rejected", decisionCode: "flag_timeout", failedReportIds: [c.r2] });

    // A: no downvote, Layer 1 warning (R4) at the window's end: flagged for the admin.
    const closed = at(now, 73 * HOUR);
    expect(await runResultVerificationSweep(closed)).toMatchObject({ closed: 1, decided: 0 });
    expect(await round(c.id, c.pa)).toMatchObject({ status: "flagged", layer1Level: "warn" });
    expect(await status(c.id)).toBe(CampaignStatus.PENDING_COMPLETION);

    expect(await runResultVerificationSweep(at(closed, 49 * HOUR))).toMatchObject({ expiredFlags: 1, decided: 1 });
    // No downvote on A: every trash point of its round did not pass.
    expect(await round(c.id, c.pa)).toMatchObject({ status: "rejected", decisionCode: "flag_timeout", failedReportIds: [c.r1, c.r4] });
    expect(await status(c.id)).toBe(CampaignStatus.ACTIVE);
    const shiftA = await prisma.campaignShiftResult.findUniqueOrThrow({ where: { shiftId: c.a.id } });
    expect(shiftA.reopenReason).toBe("#1 (R1, R4): Admin không xử lý kịp trong 48 giờ");
    const shiftB = await prisma.campaignShiftResult.findUniqueOrThrow({ where: { shiftId: c.b.id } });
    expect(shiftB.reopenReason).toBe("#2 (R2): Admin không xử lý kịp trong 48 giờ");
  });

  it("a downvote at the window's end flags the meeting point", async () => {
    const c = await seed();
    const now = new Date();
    await markDone(c, now);
    await vote(c, c.pa, REPORTER, "up", {}, at(now, HOUR));
    const neighbour = randomUUID();
    mockProfiles.set(neighbour, { createdAt: new Date(Date.now() - 30 * DAY_MS), emailVerified: true, savedLocationDistanceM: 100 });
    await vote(c, c.pa, neighbour, "down", { note: "Còn rác", reportIds: [c.r1] }, at(now, 2 * HOUR));
    expect(await round(c.id, c.pa)).toMatchObject({ status: "voting", score: 9 });
    await runResultVerificationSweep(at(now, 73 * HOUR));
    expect(await round(c.id, c.pa)).toMatchObject({ status: "flagged" });
  });

  it("reminds the reporter once after 24 h without a vote", async () => {
    const c = await seed({ statuses: { r4: "cleaned" } });
    const now = new Date();
    await markDone(c, now);
    expect(await runResultVerificationSweep(at(now, 23 * HOUR))).toMatchObject({ reminded: 0 });
    expect(await runResultVerificationSweep(at(now, 25 * HOUR))).toMatchObject({ reminded: 1 });
    expect(await runResultVerificationSweep(at(now, 26 * HOUR))).toMatchObject({ reminded: 0 });
    expect((await notices(c.id)).find((n) => n.kind === "CAMPAIGN_MEETING_POINT_CONFIRM_REMINDER")).toMatchObject({
      userIds: [REPORTER],
      payload: { meetingPointId: c.pa, reportId: c.r1, reportTitle: "R1, R4" },
    });

    // A reporter who already voted is not reminded.
    const d = await seed();
    await markDone(d, now);
    await vote(d, d.pa, REPORTER, "up", {}, at(now, HOUR));
    expect(await runResultVerificationSweep(at(now, 25 * HOUR))).toMatchObject({ reminded: 0 });
  });
});
