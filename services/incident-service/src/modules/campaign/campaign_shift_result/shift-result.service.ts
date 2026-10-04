import { Prisma } from "@prisma/client";
import {
  CampaignStatus,
  SHIFT_MEDIA_MAX_PER_SHIFT,
  SHIFT_RESULT_MAX_PHOTOS_PER_SIDE,
  SHIFT_RESULT_REPORT_STATUS,
  SHIFT_STATUS,
  type ShiftStatusValue,
} from "@da2/constants";
import prisma from "../../../config/prisma.client";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";
import {
  fetchOrganizationOwnersByUserIds,
  getUserProfile,
} from "../../organization/identity-user.client";
import type { OrganizationOwnerResponse } from "../../organization/organization.dto";
import { campaignAccessService, isPlatformAdmin } from "../campaign-access.service";
import { isEligible, shiftAttendanceService } from "../campaign_attendance/shift-attendance.service";
import { effectiveEnd, shiftStatusOf } from "./shift-status";

export type ShiftResultReportStatus =
  (typeof SHIFT_RESULT_REPORT_STATUS)[keyof typeof SHIFT_RESULT_REPORT_STATUS];

export interface SaveShiftResultInput {
  description: string;
  wasteBags?: number | null;
  wasteKg?: number | null;
  reports: Array<{
    reportId: string;
    status: ShiftResultReportStatus;
    beforeUrls: string[];
    afterUrls: string[];
  }>;
  /** Photos / videos of the shift's pool that go into the result; the others stay out. */
  mediaIds: string[];
}

export interface ShiftMediaResponse {
  id: string;
  url: string;
  kind: string;
  uploadedBy: string;
  uploader: OrganizationOwnerResponse | null;
  includedInResult: boolean;
  createdAt: Date;
}

export interface ShiftResultView {
  shiftId: string;
  status: ShiftStatusValue;
  startAt: Date;
  endAt: Date;
  endedAt: Date | null;
  leaderUserId: string | null;
  /** Leader or campaign manager: may submit the result and end the shift early. */
  canEdit: boolean;
  /** May see the result: managers, admins, the leader, and volunteers who attended. */
  canView: boolean;
  /** May add photos to the shift's pool. */
  canContribute: boolean;
  /** The campaign is no longer running (marked done or later): nothing changes any more. */
  locked: boolean;
  /** Trash reports of the shift's meeting point. */
  reportIds: string[];
  result: {
    description: string;
    wasteBags: number | null;
    wasteKg: number | null;
    submittedBy: string;
    submittedAt: Date;
    updatedAt: Date;
    reports: Array<{
      reportId: string;
      status: string;
      beforeUrls: string[];
      afterUrls: string[];
    }>;
  } | null;
  /** The shift's pool; only for those who may see the result. */
  media: ShiftMediaResponse[];
}

export interface ShiftOverviewRow {
  shiftId: string;
  dayId: string;
  meetingPointId: string;
  startAt: Date;
  endAt: Date;
  endedAt: Date | null;
  status: ShiftStatusValue;
  registered: number;
  present: number;
  eligible: number;
  hasResult: boolean;
  wasteBags: number | null;
  wasteKg: number | null;
}

export interface ShiftOverview {
  shifts: ShiftOverviewRow[];
  totals: {
    /** Shifts that are on (minVolunteers > 0). */
    activeShifts: number;
    endedShifts: number;
    /** Shifts on but not ended yet: they block marking the campaign done. */
    notEndedShiftIds: string[];
    registered: number;
    present: number;
    /** present / registered, 0–1; null without registrations. */
    presentRate: number | null;
    wasteBags: number;
    wasteKg: number;
    reports: { cleaned: number; partial: number; untouched: number };
  };
}

const HTTP_URL = /^https?:\/\/\S+$/i;
const REPORT_STATUSES = Object.values(SHIFT_RESULT_REPORT_STATUS) as string[];
const MEDIA_KINDS = ["image", "video"];

function invalid(message: string, details?: Record<string, unknown>): HttpError {
  return new HttpError(HTTP_STATUS.SHIFT_RESULT_INVALID.withMessage(message), details);
}

/**
 * Spec 4.2: a shift's result. Its leader (or a campaign manager) submits it once the shift has
 * started: the trash reports handled (photos after, optional photos before; cleaned or partial), photos from the
 * shift's pool, a description and the amount of waste. A shift past its end is "ended" only with a
 * result; it may be ended early once it has one. Volunteers who attended add photos to the pool.
 * Everything locks once the campaign is marked done. No GPS or time check of photos yet.
 */
export class ShiftResultService {
  private async loadShift(campaignId: string, shiftId: string) {
    const shift = await prisma.campaignShift.findFirst({
      where: { id: shiftId, campaignId, campaign: { deletedAt: null } },
      include: {
        campaign: { select: { id: true, status: true } },
        result: { include: { reports: { orderBy: { id: "asc" } } } },
      },
    });
    if (!shift) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Shift not found"));
    return shift;
  }

  private async canEdit(campaignId: string, leaderUserId: string | null, userId: string) {
    return leaderUserId === userId || (await campaignAccessService.canManage(campaignId, userId));
  }

  private async assertCanEdit(campaignId: string, leaderUserId: string | null, userId: string) {
    if (!(await this.canEdit(campaignId, leaderUserId, userId))) {
      throw new HttpError(
        HTTP_STATUS.CAMPAIGN_PERMISSION_DENIED.withMessage(
          "Only the shift's leader or a campaign manager submits its result",
        ),
      );
    }
  }

  /** Results and the photo pool change only while the campaign runs. */
  private assertOpen(shift: { campaign: { status: number } }) {
    if (shift.campaign.status !== CampaignStatus.ACTIVE) {
      throw new HttpError(HTTP_STATUS.SHIFT_RESULT_LOCKED);
    }
  }

  private assertStarted(shift: { minVolunteers: number; startAt: Date }, now: Date) {
    if (shift.minVolunteers <= 0) {
      throw new HttpError(HTTP_STATUS.SHIFT_NOT_STARTED.withMessage("This shift is turned off"));
    }
    if (now.getTime() < shift.startAt.getTime()) throw new HttpError(HTTP_STATUS.SHIFT_NOT_STARTED);
  }

  private async attendanceOf(shiftId: string, userId: string) {
    return prisma.campaignShiftAttendance.findUnique({
      where: { shiftId_userId: { shiftId, userId } },
      select: { excludedAt: true },
    });
  }

  private async reportIdsOf(meetingPointId: string): Promise<string[]> {
    const rows = await prisma.campaignMeetingPointReport.findMany({
      where: { meetingPointId },
      select: { reportId: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => r.reportId);
  }

  /** The shift's status for anyone; the result and its photos for those who may see them. */
  async get(
    campaignId: string,
    shiftId: string,
    viewer: { userId: string; role?: string | null },
    now = new Date(),
  ): Promise<ShiftResultView> {
    const shift = await this.loadShift(campaignId, shiftId);
    const canEdit = await this.canEdit(campaignId, shift.leaderUserId, viewer.userId);
    const attendance = canEdit ? null : await this.attendanceOf(shiftId, viewer.userId);
    const canView = canEdit || isPlatformAdmin(viewer.role) || attendance != null;
    const status = shiftStatusOf(shift, shift.result != null, now);
    const locked = shift.campaign.status !== CampaignStatus.ACTIVE;
    const started = shift.minVolunteers > 0 && now.getTime() >= shift.startAt.getTime();
    const canContribute =
      !locked && started && (canEdit || (attendance != null && attendance.excludedAt == null));

    const base = {
      shiftId,
      status,
      startAt: shift.startAt,
      endAt: shift.endAt,
      endedAt: shift.endedAt,
      leaderUserId: shift.leaderUserId,
      canEdit,
      canView,
      canContribute,
      locked,
    };
    if (!canView) return { ...base, reportIds: [], result: null, media: [] };

    const [reportIds, media] = await Promise.all([
      this.reportIdsOf(shift.meetingPointId),
      prisma.campaignShiftMedia.findMany({
        where: { shiftId, deletedAt: null },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const profiles = await fetchOrganizationOwnersByUserIds([...new Set(media.map((m) => m.uploadedBy))]);
    const result = shift.result;
    return {
      ...base,
      reportIds,
      result: result
        ? {
            description: result.description,
            wasteBags: result.wasteBags,
            wasteKg: result.wasteKg,
            submittedBy: result.submittedBy,
            submittedAt: result.submittedAt,
            updatedAt: result.updatedAt,
            reports: result.reports.map((r) => ({
              reportId: r.reportId,
              status: r.status,
              beforeUrls: r.beforeUrls,
              afterUrls: r.afterUrls,
            })),
          }
        : null,
      media: media.map((m) => ({
        id: m.id,
        url: m.url,
        kind: m.kind,
        uploadedBy: m.uploadedBy,
        uploader: getUserProfile(profiles, m.uploadedBy) ?? null,
        includedInResult: m.includedInResult,
        createdAt: m.createdAt,
      })),
    };
  }

  /** Submits or replaces the shift's result (upsert); logged. */
  async save(
    campaignId: string,
    shiftId: string,
    userId: string,
    input: SaveShiftResultInput,
    now = new Date(),
  ) {
    const shift = await this.loadShift(campaignId, shiftId);
    await this.assertCanEdit(campaignId, shift.leaderUserId, userId);
    this.assertOpen(shift);
    this.assertStarted(shift, now);

    const description = (input.description ?? "").trim();
    if (!description) throw invalid("A description is required", { field: "description" });
    const wasteBags = input.wasteBags ?? null;
    const wasteKg = input.wasteKg ?? null;
    if (wasteBags != null && (!Number.isInteger(wasteBags) || wasteBags < 0)) {
      throw invalid("wasteBags must be a whole number, 0 or more", { field: "wasteBags" });
    }
    if (wasteKg != null && (!Number.isFinite(wasteKg) || wasteKg < 0)) {
      throw invalid("wasteKg must be 0 or more", { field: "wasteKg" });
    }

    const allowed = new Set(await this.reportIdsOf(shift.meetingPointId));
    const seen = new Set<string>();
    const reports = input.reports ?? [];
    for (const r of reports) {
      if (!allowed.has(r.reportId)) {
        throw invalid("This trash report is not part of the shift's meeting point", {
          reportId: r.reportId,
        });
      }
      if (seen.has(r.reportId)) throw invalid("A trash report is listed twice", { reportId: r.reportId });
      seen.add(r.reportId);
      if (!REPORT_STATUSES.includes(r.status)) {
        throw invalid("A trash report is either cleaned or partial", { reportId: r.reportId });
      }
      // Photos before are optional; at least one after shows the work.
      const sides = [r.beforeUrls ?? [], r.afterUrls ?? []];
      if ((r.afterUrls ?? []).length === 0) {
        throw invalid("Each trash report needs at least one photo after", {
          reportId: r.reportId,
        });
      }
      if (
        sides.some(
          (urls) =>
            urls.length > SHIFT_RESULT_MAX_PHOTOS_PER_SIDE ||
            urls.some((u) => typeof u !== "string" || !HTTP_URL.test(u)),
        )
      ) {
        throw invalid("Invalid photos for a trash report", { reportId: r.reportId });
      }
    }

    const mediaIds = [...new Set(input.mediaIds ?? [])];
    if (mediaIds.length > 0) {
      const found = await prisma.campaignShiftMedia.count({
        where: { id: { in: mediaIds }, shiftId, deletedAt: null },
      });
      if (found !== mediaIds.length) throw invalid("Some photos are not in this shift's pool");
    }
    if (reports.length === 0 && mediaIds.length === 0) {
      throw invalid("Add at least one trash report or one photo of the activity");
    }

    const created = shift.result == null;
    await prisma.$transaction(async (tx) => {
      const saved = await tx.campaignShiftResult.upsert({
        where: { shiftId },
        create: { campaignId, shiftId, description, wasteBags, wasteKg, submittedBy: userId, submittedAt: now },
        update: { description, wasteBags, wasteKg, submittedBy: userId },
      });
      await tx.campaignShiftResultReport.deleteMany({ where: { resultId: saved.id } });
      if (reports.length > 0) {
        await tx.campaignShiftResultReport.createMany({
          data: reports.map((r) => ({
            resultId: saved.id,
            reportId: r.reportId,
            status: r.status,
            beforeUrls: r.beforeUrls,
            afterUrls: r.afterUrls,
          })),
        });
      }
      await tx.campaignShiftMedia.updateMany({
        where: { shiftId, deletedAt: null },
        data: { includedInResult: false },
      });
      if (mediaIds.length > 0) {
        await tx.campaignShiftMedia.updateMany({
          where: { id: { in: mediaIds }, shiftId },
          data: { includedInResult: true },
        });
      }
      await tx.campaignStatusLog.create({
        data: {
          campaignId,
          type: "EDIT",
          event: "shift_result",
          fromStatus: shift.campaign.status,
          toStatus: shift.campaign.status,
          actorId: userId,
          actorRole: "manager",
          changes: {
            shiftId,
            created,
            reports: reports.map((r) => ({ reportId: r.reportId, status: r.status })),
            media: mediaIds.length,
            wasteBags,
            wasteKg,
          },
        },
      });
    });
    return this.get(campaignId, shiftId, { userId }, now);
  }

  /**
   * Ends a running shift early, once it has a result: it ends now, attendance closes and everyone
   * still checked in is checked out; the 60% rule counts until now. Logged.
   */
  async endEarly(campaignId: string, shiftId: string, userId: string, now = new Date()) {
    const shift = await this.loadShift(campaignId, shiftId);
    await this.assertCanEdit(campaignId, shift.leaderUserId, userId);
    this.assertOpen(shift);
    this.assertStarted(shift, now);
    if (now.getTime() >= effectiveEnd(shift).getTime()) {
      throw new HttpError(HTTP_STATUS.CONFLICT.withMessage("This shift has already ended"));
    }
    if (!shift.result) throw new HttpError(HTTP_STATUS.SHIFT_RESULT_REQUIRED);

    const checkedOut = await prisma.$transaction(async (tx) => {
      const updated = await tx.campaignShift.updateMany({
        where: { id: shiftId, endedAt: null },
        data: { endedAt: now },
      });
      if (updated.count === 0) {
        throw new HttpError(HTTP_STATUS.CONFLICT.withMessage("This shift has already ended"));
      }
      const closed = await shiftAttendanceService.closeAllInTx(tx, shiftId, userId, now, now);
      await tx.campaignStatusLog.create({
        data: {
          campaignId,
          type: "EDIT",
          event: "shift_ended_early",
          fromStatus: shift.campaign.status,
          toStatus: shift.campaign.status,
          actorId: userId,
          actorRole: "manager",
          changes: {
            shiftId,
            plannedEndAt: shift.endAt.toISOString(),
            endedAt: now.toISOString(),
            checkedOut: closed.checkedOut,
          },
        },
      });
      return closed.checkedOut;
    });
    return { shiftId, endedAt: now, status: SHIFT_STATUS.ENDED, checkedOut };
  }

  /** Adds a photo or video to the shift's pool: volunteers who attended, the leader, managers. */
  async addMedia(
    campaignId: string,
    shiftId: string,
    userId: string,
    input: { url: string; kind: string },
    now = new Date(),
  ): Promise<ShiftMediaResponse> {
    const shift = await this.loadShift(campaignId, shiftId);
    if (!(await this.canEdit(campaignId, shift.leaderUserId, userId))) {
      const attendance = await this.attendanceOf(shiftId, userId);
      if (!attendance || attendance.excludedAt) {
        throw new HttpError(
          HTTP_STATUS.CAMPAIGN_PERMISSION_DENIED.withMessage(
            "Only volunteers who attended this shift, its leader or a campaign manager add photos",
          ),
        );
      }
    }
    this.assertOpen(shift);
    this.assertStarted(shift, now);
    const url = (input.url ?? "").trim();
    if (!HTTP_URL.test(url)) throw invalid("A valid photo or video URL is required", { field: "url" });
    if (!MEDIA_KINDS.includes(input.kind)) throw invalid("kind is image or video", { field: "kind" });
    const count = await prisma.campaignShiftMedia.count({ where: { shiftId, deletedAt: null } });
    if (count >= SHIFT_MEDIA_MAX_PER_SHIFT) {
      throw invalid(`At most ${SHIFT_MEDIA_MAX_PER_SHIFT} photos and videos per shift`);
    }
    const created = await prisma.campaignShiftMedia.create({
      data: { campaignId, shiftId, url, kind: input.kind, uploadedBy: userId, createdAt: now },
    });
    return {
      id: created.id,
      url: created.url,
      kind: created.kind,
      uploadedBy: created.uploadedBy,
      uploader: null,
      includedInResult: created.includedInResult,
      createdAt: created.createdAt,
    };
  }

  /** Removes a photo from the pool (and from the result): its uploader, the leader, managers. */
  async removeMedia(campaignId: string, shiftId: string, mediaId: string, userId: string, now = new Date()) {
    const shift = await this.loadShift(campaignId, shiftId);
    const media = await prisma.campaignShiftMedia.findFirst({
      where: { id: mediaId, shiftId, deletedAt: null },
    });
    if (!media) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Photo not found"));
    if (media.uploadedBy !== userId) await this.assertCanEdit(campaignId, shift.leaderUserId, userId);
    this.assertOpen(shift);
    await prisma.campaignShiftMedia.update({
      where: { id: mediaId },
      data: { deletedAt: now, includedInResult: false },
    });
    return { id: mediaId, removed: true };
  }

  /** Spec 4.2: every shift's status and figures, with campaign totals (managers and admins). */
  async overview(
    campaignId: string,
    viewer: { userId: string; role?: string | null },
    now = new Date(),
  ): Promise<ShiftOverview> {
    if (!isPlatformAdmin(viewer.role)) {
      await campaignAccessService.assertCanManage(campaignId, viewer.userId);
    }
    const shifts = await prisma.campaignShift.findMany({
      where: { campaignId, campaign: { deletedAt: null } },
      include: { result: { include: { reports: { select: { reportId: true, status: true } } } } },
      orderBy: [{ startAt: "asc" }],
    });
    const shiftIds = shifts.map((s) => s.id);
    const [registrations, attendances, pointReports] = await Promise.all([
      prisma.campaignShiftRegistration.groupBy({
        by: ["shiftId"],
        where: { shiftId: { in: shiftIds }, leftAt: null },
        _count: { _all: true },
      }),
      prisma.campaignShiftAttendance.findMany({
        where: { shiftId: { in: shiftIds } },
        select: { shiftId: true, checkInAt: true, checkOutAt: true, excludedAt: true },
      }),
      prisma.campaignMeetingPointReport.findMany({
        where: { campaignId, meetingPoint: { deletedAt: null } },
        select: { reportId: true },
      }),
    ]);
    const registered = new Map(registrations.map((r) => [r.shiftId, r._count._all]));

    const rows: ShiftOverviewRow[] = shifts.map((s) => {
      const atts = attendances.filter((a) => a.shiftId === s.id && !a.excludedAt);
      return {
        shiftId: s.id,
        dayId: s.dayId,
        meetingPointId: s.meetingPointId,
        startAt: s.startAt,
        endAt: s.endAt,
        endedAt: s.endedAt,
        status: shiftStatusOf(s, s.result != null, now),
        registered: registered.get(s.id) ?? 0,
        present: atts.length,
        eligible: atts.filter((a) => isEligible(a, s)).length,
        hasResult: s.result != null,
        wasteBags: s.result?.wasteBags ?? null,
        wasteKg: s.result?.wasteKg ?? null,
      };
    });

    const active = rows.filter((r) => r.status !== SHIFT_STATUS.OFF);
    // A report handled on several shifts counts once, at its best state.
    const best = new Map<string, string>();
    for (const s of shifts) {
      for (const r of s.result?.reports ?? []) {
        if (best.get(r.reportId) !== SHIFT_RESULT_REPORT_STATUS.CLEANED) best.set(r.reportId, r.status);
      }
    }
    const reportIds = [...new Set(pointReports.map((r) => r.reportId))];
    const cleaned = reportIds.filter((id) => best.get(id) === SHIFT_RESULT_REPORT_STATUS.CLEANED).length;
    const partial = reportIds.filter((id) => best.get(id) === SHIFT_RESULT_REPORT_STATUS.PARTIAL).length;
    const sumRegistered = active.reduce((n, r) => n + r.registered, 0);
    const sumPresent = active.reduce((n, r) => n + r.present, 0);
    return {
      shifts: rows,
      totals: {
        activeShifts: active.length,
        endedShifts: active.filter((r) => r.status === SHIFT_STATUS.ENDED).length,
        notEndedShiftIds: active.filter((r) => r.status !== SHIFT_STATUS.ENDED).map((r) => r.shiftId),
        registered: sumRegistered,
        present: sumPresent,
        presentRate: sumRegistered > 0 ? sumPresent / sumRegistered : null,
        wasteBags: rows.reduce((n, r) => n + (r.wasteBags ?? 0), 0),
        wasteKg: Math.round(rows.reduce((n, r) => n + (r.wasteKg ?? 0), 0) * 100) / 100,
        reports: { cleaned, partial, untouched: reportIds.length - cleaned - partial },
      },
    };
  }

  /** Spec 5.1: the campaign is marked done only once every shift that is on has ended. */
  async assertAllShiftsEnded(
    campaignId: string,
    now = new Date(),
    db: Prisma.TransactionClient | typeof prisma = prisma,
  ) {
    const shifts = await db.campaignShift.findMany({
      where: { campaignId, minVolunteers: { gt: 0 } },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        endedAt: true,
        minVolunteers: true,
        result: { select: { id: true } },
      },
    });
    const notEnded = shifts
      .filter((s) => shiftStatusOf(s, s.result != null, now) !== SHIFT_STATUS.ENDED)
      .map((s) => s.id);
    if (notEnded.length > 0) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_SHIFTS_NOT_ENDED, { shiftIds: notEnded });
    }
  }
}

export const shiftResultService = new ShiftResultService();
