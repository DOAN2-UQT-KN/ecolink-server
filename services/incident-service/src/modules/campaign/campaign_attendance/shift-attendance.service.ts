import { Prisma } from "@prisma/client";
import {
  CAMPAIGN_ATTENDANCE_CHECKOUT_GRACE_MINUTES,
  CAMPAIGN_ATTENDANCE_CHECKOUT_MIN_MINUTES,
  CAMPAIGN_ATTENDANCE_GEOFENCE_M,
  CAMPAIGN_ATTENDANCE_MANUAL_MAX_RATIO,
  CAMPAIGN_ATTENDANCE_MAX_ACCURACY_M,
  CAMPAIGN_ATTENDANCE_MIN_PRESENCE_RATIO,
  CAMPAIGN_ATTENDANCE_OPEN_BEFORE_MINUTES,
  CAMPAIGN_ATTENDANCE_QR_PERIOD_SEC,
  CAMPAIGN_ATTENDANCE_SESSION_MINUTES,
  CampaignStatus,
} from "@da2/constants";
import prisma from "../../../config/prisma.client";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";
import {
  fetchOrganizationOwnersByUserIds,
  getUserProfile,
} from "../../organization/identity-user.client";
import type { OrganizationOwnerResponse } from "../../organization/organization.dto";
import { campaignAccessService, isPlatformAdmin } from "../campaign-access.service";
import { haversineKm } from "../campaign-submit-validation";
import { signShiftQr, verifyShiftQr } from "./shift-attendance-qr";

const MINUTE_MS = 60 * 1000;

/** Attendance opens while the campaign is upcoming (people gather before the first start) or running. */
const ATTENDANCE_STATUSES: number[] = [CampaignStatus.UPCOMING, CampaignStatus.ACTIVE];

type ShiftWindow = { startAt: Date; endAt: Date; gatherAt: Date | null };

/** From a little before the gathering time (or start) until check-outs stop after the end. */
function windowOf(shift: ShiftWindow) {
  const first = Math.min(shift.startAt.getTime(), shift.gatherAt?.getTime() ?? Infinity);
  return {
    openFrom: new Date(first - CAMPAIGN_ATTENDANCE_OPEN_BEFORE_MINUTES * MINUTE_MS),
    checkInUntil: shift.endAt,
    checkOutUntil: new Date(shift.endAt.getTime() + CAMPAIGN_ATTENDANCE_CHECKOUT_GRACE_MINUTES * MINUTE_MS),
  };
}

/** Time present within the shift's hours; nothing without a check-out. */
export function presenceMs(
  att: { checkInAt: Date; checkOutAt: Date | null },
  shift: { startAt: Date; endAt: Date },
): number {
  if (!att.checkOutAt) return 0;
  const from = Math.max(att.checkInAt.getTime(), shift.startAt.getTime());
  const to = Math.min(att.checkOutAt.getTime(), shift.endAt.getTime());
  return Math.max(0, to - from);
}

/** Spec 4.1: present at least 60% of the shift, with a check-out. */
export function isEligible(
  att: { checkInAt: Date; checkOutAt: Date | null },
  shift: { startAt: Date; endAt: Date },
): boolean {
  const length = shift.endAt.getTime() - shift.startAt.getTime();
  return length > 0 && presenceMs(att, shift) >= CAMPAIGN_ATTENDANCE_MIN_PRESENCE_RATIO * length;
}

export interface ScanInput {
  token: string;
  latitude: number;
  longitude: number;
  /** Metres, as the device reports it. */
  accuracy: number;
  /** When the code was scanned, for a scan synced later (weak signal); defaults to now. */
  scannedAt?: Date;
}

export type ScanAction = "check_in" | "check_out" | "already_checked_in" | "already_checked_out";

export interface ScanResult {
  action: ScanAction;
  shiftId: string;
  checkInAt: Date;
  checkOutAt: Date | null;
  eligible: boolean;
}

export interface ShiftAttendanceRow {
  userId: string;
  volunteer: OrganizationOwnerResponse;
  checkInAt: Date;
  checkOutAt: Date | null;
  checkOutMethod: string | null;
  manual: boolean;
  manualReason: string | null;
  preRegistered: boolean;
  offline: boolean;
  presenceMinutes: number;
  eligible: boolean;
}

export interface ShiftAttendanceView {
  shiftId: string;
  startAt: Date;
  endAt: Date;
  leaderUserId: string | null;
  session: { id: string; openedBy: string; expiresAt: Date } | null;
  canRun: boolean;
  present: number;
  manual: number;
  eligible: number;
  attendances: ShiftAttendanceRow[];
}

/**
 * Attendance per shift (spec 4.1): the shift's leader (or a campaign manager) opens a QR session;
 * volunteers scan a code that changes every period, from within 50 m of the meeting point. The
 * first scan checks in, a later one checks out; closing the session checks everyone out. Leaders
 * and managers never check themselves in on a shift they run.
 */
export class ShiftAttendanceService {
  private async loadShift(campaignId: string, shiftId: string) {
    const shift = await prisma.campaignShift.findFirst({
      where: { id: shiftId, campaignId, campaign: { deletedAt: null } },
      include: {
        meetingPoint: { select: { latitude: true, longitude: true } },
        campaign: { select: { id: true, status: true } },
      },
    });
    if (!shift) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Shift not found"));
    return shift;
  }

  /** The shift's leader, or anyone who manages the campaign. */
  private async canRun(campaignId: string, leaderUserId: string | null, userId: string): Promise<boolean> {
    return leaderUserId === userId || (await campaignAccessService.canManage(campaignId, userId));
  }

  private async assertCanRun(campaignId: string, leaderUserId: string | null, userId: string) {
    if (!(await this.canRun(campaignId, leaderUserId, userId))) {
      throw new HttpError(
        HTTP_STATUS.CAMPAIGN_PERMISSION_DENIED.withMessage(
          "Only the shift's leader or a campaign manager runs its attendance",
        ),
      );
    }
  }

  private assertRunning(
    shift: ShiftWindow & { minVolunteers: number; campaign: { status: number } },
    at: Date,
    until: "checkIn" | "checkOut",
  ) {
    const { openFrom, checkInUntil, checkOutUntil } = windowOf(shift);
    const end = until === "checkIn" ? checkInUntil : checkOutUntil;
    if (
      shift.minVolunteers <= 0 ||
      !ATTENDANCE_STATUSES.includes(shift.campaign.status) ||
      at.getTime() < openFrom.getTime() ||
      at.getTime() > end.getTime()
    ) {
      throw new HttpError(HTTP_STATUS.ATTENDANCE_NOT_OPEN);
    }
  }

  private openSessionOf(shiftId: string, now: Date) {
    return prisma.campaignShiftAttendanceSession.findFirst({
      where: { shiftId, closedAt: null, expiresAt: { gt: now } },
      orderBy: { openedAt: "desc" },
    });
  }

  /** Opens a session, or returns the one still open. */
  async openSession(campaignId: string, shiftId: string, userId: string, now = new Date()) {
    const shift = await this.loadShift(campaignId, shiftId);
    await this.assertCanRun(campaignId, shift.leaderUserId, userId);
    this.assertRunning(shift, now, "checkOut");
    const open = await this.openSessionOf(shiftId, now);
    if (open) return { id: open.id, openedBy: open.openedBy, expiresAt: open.expiresAt };
    const { checkOutUntil } = windowOf(shift);
    const expiresAt = new Date(
      Math.min(now.getTime() + CAMPAIGN_ATTENDANCE_SESSION_MINUTES * MINUTE_MS, checkOutUntil.getTime()),
    );
    const created = await prisma.campaignShiftAttendanceSession.create({
      data: { campaignId, shiftId, openedBy: userId, openedAt: now, expiresAt },
    });
    return { id: created.id, openedBy: created.openedBy, expiresAt: created.expiresAt };
  }

  /** A fresh code for the open session; the leader's screen asks again every period. */
  async issueQr(campaignId: string, shiftId: string, userId: string, now = new Date()) {
    const shift = await this.loadShift(campaignId, shiftId);
    await this.assertCanRun(campaignId, shift.leaderUserId, userId);
    const session = await this.openSessionOf(shiftId, now);
    if (!session) throw new HttpError(HTTP_STATUS.ATTENDANCE_NOT_OPEN);
    return {
      token: signShiftQr({ campaignId, shiftId, sessionId: session.id }, now),
      periodSec: CAMPAIGN_ATTENDANCE_QR_PERIOD_SEC,
      sessionId: session.id,
      sessionExpiresAt: session.expiresAt,
    };
  }

  async scan(campaignId: string, userId: string, input: ScanInput, now = new Date()): Promise<ScanResult> {
    const scannedAt = input.scannedAt ?? now;
    if (scannedAt.getTime() > now.getTime() + MINUTE_MS) {
      throw new HttpError(HTTP_STATUS.ATTENDANCE_QR_INVALID);
    }
    const claims = verifyShiftQr(input.token, scannedAt);
    if (claims.campaignId !== campaignId) throw new HttpError(HTTP_STATUS.ATTENDANCE_QR_INVALID);

    const session = await prisma.campaignShiftAttendanceSession.findUnique({
      where: { id: claims.sessionId },
    });
    if (
      !session ||
      session.shiftId !== claims.shiftId ||
      scannedAt.getTime() < session.openedAt.getTime() - 5_000 ||
      scannedAt.getTime() > session.expiresAt.getTime() ||
      (session.closedAt && scannedAt.getTime() >= session.closedAt.getTime())
    ) {
      throw new HttpError(HTTP_STATUS.ATTENDANCE_NOT_OPEN);
    }
    const shift = await this.loadShift(campaignId, claims.shiftId);
    this.assertRunning(shift, scannedAt, "checkOut");

    // Spec 4.1.6: whoever runs the shift scans another shift's code to earn points.
    if (userId === shift.leaderUserId || userId === session.openedBy) {
      throw new HttpError(HTTP_STATUS.ATTENDANCE_SELF_CHECK_IN);
    }
    if (!(input.accuracy >= 0) || input.accuracy > CAMPAIGN_ATTENDANCE_MAX_ACCURACY_M) {
      throw new HttpError(HTTP_STATUS.ATTENDANCE_GPS_INACCURATE);
    }
    const distanceM = haversineKm(input, shift.meetingPoint) * 1000;
    if (distanceM > CAMPAIGN_ATTENDANCE_GEOFENCE_M) {
      throw new HttpError(HTTP_STATUS.ATTENDANCE_OUTSIDE_AREA, { distanceM: Math.round(distanceM) });
    }

    const offline = now.getTime() - scannedAt.getTime() > CAMPAIGN_ATTENDANCE_QR_PERIOD_SEC * 1000;
    const result = (
      row: { checkInAt: Date; checkOutAt: Date | null },
      action: ScanAction,
    ): ScanResult => ({
      action,
      shiftId: shift.id,
      checkInAt: row.checkInAt,
      checkOutAt: row.checkOutAt,
      eligible: isEligible(row, shift),
    });

    const existing = await prisma.campaignShiftAttendance.findUnique({
      where: { shiftId_userId: { shiftId: shift.id, userId } },
    });
    if (!existing) {
      if (scannedAt.getTime() > shift.endAt.getTime()) {
        throw new HttpError(HTTP_STATUS.ATTENDANCE_NOT_OPEN);
      }
      const registered = await prisma.campaignShiftRegistration.count({
        where: { shiftId: shift.id, userId, leftAt: null },
      });
      try {
        const created = await prisma.campaignShiftAttendance.create({
          data: {
            campaignId,
            shiftId: shift.id,
            userId,
            checkInAt: scannedAt,
            checkInLatitude: input.latitude,
            checkInLongitude: input.longitude,
            checkInAccuracy: input.accuracy,
            preRegistered: registered > 0,
            offline,
            sessionId: session.id,
          },
        });
        return result(created, "check_in");
      } catch (error) {
        // The same scan arrived twice at once: the first one checked in.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const row = await prisma.campaignShiftAttendance.findUniqueOrThrow({
            where: { shiftId_userId: { shiftId: shift.id, userId } },
          });
          return result(row, "already_checked_in");
        }
        throw error;
      }
    }
    if (existing.checkOutAt) return result(existing, "already_checked_out");
    if (
      scannedAt.getTime() - existing.checkInAt.getTime() <
      CAMPAIGN_ATTENDANCE_CHECKOUT_MIN_MINUTES * MINUTE_MS
    ) {
      return result(existing, "already_checked_in");
    }
    const updated = await prisma.campaignShiftAttendance.update({
      where: { id: existing.id },
      data: {
        checkOutAt: scannedAt,
        checkOutLatitude: input.latitude,
        checkOutLongitude: input.longitude,
        checkOutAccuracy: input.accuracy,
        checkOutMethod: "scan",
        offline: existing.offline || offline,
      },
    });
    return result(updated, "check_out");
  }

  /** Ends attendance: the open sessions close and everyone still checked in is checked out. */
  async closeSession(campaignId: string, shiftId: string, userId: string, now = new Date()) {
    const shift = await this.loadShift(campaignId, shiftId);
    await this.assertCanRun(campaignId, shift.leaderUserId, userId);
    const checkOutAt = new Date(Math.min(now.getTime(), shift.endAt.getTime()));
    return prisma.$transaction(async (tx) => {
      await tx.campaignShiftAttendanceSession.updateMany({
        where: { shiftId, closedAt: null },
        data: { closedAt: now, closedBy: userId },
      });
      const open = await tx.campaignShiftAttendance.findMany({
        where: { shiftId, checkOutAt: null },
        select: { id: true, checkInAt: true },
      });
      for (const row of open) {
        await tx.campaignShiftAttendance.update({
          where: { id: row.id },
          data: {
            checkOutAt: new Date(Math.max(checkOutAt.getTime(), row.checkInAt.getTime())),
            checkOutMethod: "session_close",
            recordedBy: userId,
          },
        });
      }
      return { checkedOut: open.length };
    });
  }

  /**
   * Spec 4.1.5: a leader or manager records someone whose phone failed, with a reason; at most
   * 20% of the people present (at least one). Never for oneself. Logged.
   */
  async addManual(
    campaignId: string,
    shiftId: string,
    actorId: string,
    input: { userId: string; reason: string; checkInAt?: Date },
    now = new Date(),
  ) {
    const shift = await this.loadShift(campaignId, shiftId);
    await this.assertCanRun(campaignId, shift.leaderUserId, actorId);
    this.assertRunning(shift, now, "checkOut");
    if (input.userId === actorId) throw new HttpError(HTTP_STATUS.ATTENDANCE_SELF_CHECK_IN);
    const reason = input.reason.trim();
    if (!reason) {
      throw new HttpError(HTTP_STATUS.VALIDATION_ERROR.withMessage("A reason is required"));
    }
    const asked = input.checkInAt ?? now;
    const checkInAt = new Date(
      Math.min(Math.max(asked.getTime(), shift.startAt.getTime()), shift.endAt.getTime(), now.getTime()),
    );

    return prisma.$transaction(
      async (tx) => {
        const rows = await tx.campaignShiftAttendance.findMany({
          where: { shiftId },
          select: { userId: true, manual: true },
        });
        if (rows.some((r) => r.userId === input.userId)) {
          throw new HttpError(HTTP_STATUS.ATTENDANCE_ALREADY_RECORDED);
        }
        const present = rows.length + 1;
        const manual = rows.filter((r) => r.manual).length + 1;
        if (manual > Math.max(1, Math.floor(CAMPAIGN_ATTENDANCE_MANUAL_MAX_RATIO * present))) {
          throw new HttpError(HTTP_STATUS.ATTENDANCE_MANUAL_LIMIT);
        }
        const registered = await tx.campaignShiftRegistration.count({
          where: { shiftId, userId: input.userId, leftAt: null },
        });
        const created = await tx.campaignShiftAttendance.create({
          data: {
            campaignId,
            shiftId,
            userId: input.userId,
            checkInAt,
            manual: true,
            manualReason: reason,
            recordedBy: actorId,
            preRegistered: registered > 0,
          },
        });
        await tx.campaignStatusLog.create({
          data: {
            campaignId,
            type: "EDIT",
            event: "manual_attendance",
            fromStatus: shift.campaign.status,
            toStatus: shift.campaign.status,
            actorId,
            actorRole: "manager",
            reason,
            changes: { shiftId, userId: input.userId, checkInAt: checkInAt.toISOString() },
          },
        });
        return { userId: created.userId, checkInAt: created.checkInAt };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /** Who is present on a shift: its leader, campaign managers and platform admins. */
  async listForShift(
    campaignId: string,
    shiftId: string,
    viewer: { userId: string; role?: string | null },
    now = new Date(),
  ): Promise<ShiftAttendanceView> {
    const shift = await this.loadShift(campaignId, shiftId);
    const canRun = await this.canRun(campaignId, shift.leaderUserId, viewer.userId);
    if (!canRun && !isPlatformAdmin(viewer.role)) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_PERMISSION_DENIED);
    }
    const [rows, session] = await Promise.all([
      prisma.campaignShiftAttendance.findMany({ where: { shiftId }, orderBy: { checkInAt: "asc" } }),
      this.openSessionOf(shiftId, now),
    ]);
    const profiles = await fetchOrganizationOwnersByUserIds(rows.map((r) => r.userId));
    const attendances = rows.map((r) => ({
      userId: r.userId,
      volunteer: getUserProfile(profiles, r.userId) ?? { id: r.userId, name: "", avatar: null, bio: null },
      checkInAt: r.checkInAt,
      checkOutAt: r.checkOutAt,
      checkOutMethod: r.checkOutMethod,
      manual: r.manual,
      manualReason: r.manualReason,
      preRegistered: r.preRegistered,
      offline: r.offline,
      presenceMinutes: Math.round(presenceMs(r, shift) / MINUTE_MS),
      eligible: isEligible(r, shift),
    }));
    return {
      shiftId,
      startAt: shift.startAt,
      endAt: shift.endAt,
      leaderUserId: shift.leaderUserId,
      session: session ? { id: session.id, openedBy: session.openedBy, expiresAt: session.expiresAt } : null,
      canRun,
      present: attendances.length,
      manual: attendances.filter((a) => a.manual).length,
      eligible: attendances.filter((a) => a.eligible).length,
      attendances,
    };
  }

  /**
   * Spec 5.3 (approval share still 100%): green points per person, the tier's points times the
   * share of their registered shifts they attended long enough (shifts attended without
   * registering count too; at most 100%). Nobody without an eligible shift.
   */
  async completionCredits(
    campaignId: string,
    greenPoints: number,
  ): Promise<Array<{ userId: string; points: number }>> {
    const [rows, registrations] = await Promise.all([
      prisma.campaignShiftAttendance.findMany({
        where: { campaignId },
        include: { shift: { select: { startAt: true, endAt: true } } },
      }),
      prisma.campaignShiftRegistration.groupBy({
        by: ["userId"],
        where: { campaignId, leftAt: null },
        _count: { _all: true },
      }),
    ]);
    const registered = new Map(registrations.map((r) => [r.userId, r._count._all]));
    const eligible = new Map<string, number>();
    for (const row of rows) {
      if (isEligible(row, row.shift)) eligible.set(row.userId, (eligible.get(row.userId) ?? 0) + 1);
    }
    return [...eligible.entries()]
      .map(([userId, count]) => {
        const share = Math.min(1, count / Math.max(1, registered.get(userId) ?? 0));
        return { userId, points: Math.round(greenPoints * share) };
      })
      .filter((c) => c.points > 0);
  }
}

export const shiftAttendanceService = new ShiftAttendanceService();
