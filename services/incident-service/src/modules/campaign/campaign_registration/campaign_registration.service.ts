import {
  CAMPAIGN_NEARBY_REINVITE_COOLDOWN_HOURS,
  CAMPAIGN_REGISTRABLE_STATUSES,
  CampaignRegistrationWarning,
  type CampaignRegistrationWarningValue,
  type CampaignRequirements,
} from "@da2/constants";
import { Prisma } from "@prisma/client";
import prisma from "../../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../../constants/http-status";
import {
  fetchOrganizationOwnersByUserIds,
  getUserProfile,
} from "../../organization/identity-user.client";
import type { OrganizationOwnerResponse } from "../../organization/organization.dto";
import { campaignAccessService } from "../campaign-access.service";
import { campaignAttendanceRepository } from "../campaign_attendance/campaign_attendance.repository";
import { campaignTitleNotificationPayload } from "../campaign-i18n";
import { findNearbyUserIds } from "../nearby-users";
import { enqueueWebsiteNotificationsToUsers } from "../notification-jobs.client";
import { emitOutbox } from "../../../outbox/outbox.writer";
import { OutboxEventType } from "../../../outbox/outbox.types";
import { localDayMonth, localHourMinute } from "./staffing-shared";

const HOUR_MS = 60 * 60 * 1000;
import { campaignRegistrationRepository } from "./campaign_registration.repository";

export interface ShiftConflict {
  campaignId: string;
  campaignTitle: string;
  shiftId: string;
  startAt: Date;
  endAt: Date;
}

export interface RegistrationOptionShift {
  id: string;
  dayId: string;
  meetingPointId: string;
  meetingPointName: string | null;
  meetingPointAddress: string | null;
  startAt: Date;
  endAt: Date;
  gatherAt: Date | null;
  minVolunteers: number;
  maxVolunteers: number | null;
  registeredCount: number;
  /** Volunteers still missing to reach the minimum. */
  shortBy: number;
  overMax: boolean;
  registeredByMe: boolean;
  /** The viewer's shifts in other campaigns that overlap this one. */
  conflicts: ShiftConflict[];
}

export interface RegistrationOptions {
  registrable: boolean;
  /** Why registering is closed: the status, or no shift left. */
  reason: "STATUS" | "NO_SHIFT" | null;
  requirements: CampaignRequirements | null;
  safetyNotes: string | null;
  days: Array<{ id: string; startAt: Date; endAt: Date }>;
  /** Open shifts, plus the ones the viewer holds (they may have started). */
  shifts: RegistrationOptionShift[];
}

export interface MyRegistrationResult {
  shiftIds: string[];
  added: string[];
  left: string[];
  warnings: CampaignRegistrationWarningValue[];
}

export interface RegisteredShiftVolunteer {
  userId: string;
  volunteer: OrganizationOwnerResponse;
  registeredAt: Date;
  checkedInAt: Date | null;
}

export interface ShiftRegistrations {
  shiftId: string;
  dayId: string;
  meetingPointId: string;
  meetingPointName: string | null;
  startAt: Date;
  endAt: Date;
  minVolunteers: number;
  maxVolunteers: number | null;
  registeredCount: number;
  volunteers: RegisteredShiftVolunteer[];
}

const overlaps = (a: { startAt: Date; endAt: Date }, b: { startAt: Date; endAt: Date }) =>
  a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();

const isOpen = (shift: { minVolunteers: number; startAt: Date }, now: Date) =>
  shift.minVolunteers > 0 && shift.startAt.getTime() > now.getTime();

/**
 * Per-shift registration (spec 3.1): effective at once, no approval and no cap. Overlaps and
 * full shifts only warn. Registering is only for news and headcount, so leaving a shift before
 * it starts (3.3) is free and recorded nowhere.
 */
export class CampaignRegistrationService {
  private async loadCampaign(campaignId: string) {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, deletedAt: null },
      select: {
        id: true,
        title: true,
        titleVi: true,
        titleEn: true,
        status: true,
        lastNearbyInviteAt: true,
        campaignManagers: { where: { deletedAt: null }, select: { userId: true } },
        createdBy: true,
        requirements: true,
        safetyNotes: true,
        days: { orderBy: { startAt: "asc" }, select: { id: true, startAt: true, endAt: true } },
        shifts: {
          orderBy: { startAt: "asc" },
          include: {
            meetingPoint: {
              select: {
                name: true,
                detailAddress: true,
                sortOrder: true,
                latitude: true,
                longitude: true,
              },
            },
          },
        },
      },
    });
    if (!campaign) {
      throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Campaign not found"));
    }
    return campaign;
  }

  async getOptions(campaignId: string, userId: string, now = new Date()): Promise<RegistrationOptions> {
    const campaign = await this.loadCampaign(campaignId);
    const [counts, mine] = await Promise.all([
      campaignRegistrationRepository.countByShift(campaignId),
      campaignRegistrationRepository.findMyShiftIds(campaignId, userId),
    ]);
    const mineSet = new Set(mine);
    const statusOpen = CAMPAIGN_REGISTRABLE_STATUSES.includes(campaign.status);
    const listed = campaign.shifts.filter(
      (s) => (statusOpen && isOpen(s, now)) || mineSet.has(s.id),
    );

    const elsewhere =
      listed.length > 0
        ? await campaignRegistrationRepository.findOverlappingElsewhere(
            userId,
            campaignId,
            new Date(Math.min(...listed.map((s) => s.startAt.getTime()))),
            new Date(Math.max(...listed.map((s) => s.endAt.getTime()))),
          )
        : [];

    const shifts = listed
      .sort(
        (a, b) =>
          a.startAt.getTime() - b.startAt.getTime() ||
          a.meetingPoint.sortOrder - b.meetingPoint.sortOrder,
      )
      .map((s): RegistrationOptionShift => {
        const registeredCount = counts.get(s.id) ?? 0;
        return {
          id: s.id,
          dayId: s.dayId,
          meetingPointId: s.meetingPointId,
          meetingPointName: s.meetingPoint.name,
          meetingPointAddress: s.meetingPoint.detailAddress,
          startAt: s.startAt,
          endAt: s.endAt,
          gatherAt: s.gatherAt,
          minVolunteers: s.minVolunteers,
          maxVolunteers: s.maxVolunteers,
          registeredCount,
          shortBy: Math.max(0, s.minVolunteers - registeredCount),
          overMax: s.maxVolunteers != null && registeredCount > s.maxVolunteers,
          registeredByMe: mineSet.has(s.id),
          conflicts: elsewhere
            .filter((r) => overlaps(r.shift, s))
            .map((r) => ({
              campaignId: r.campaignId,
              campaignTitle: r.campaign.title,
              shiftId: r.shift.id,
              startAt: r.shift.startAt,
              endAt: r.shift.endAt,
            })),
        };
      });

    const openCount = shifts.filter((s) => isOpen(s, now)).length;
    return {
      registrable: statusOpen && openCount > 0,
      reason: !statusOpen ? "STATUS" : openCount === 0 ? "NO_SHIFT" : null,
      requirements: (campaign.requirements as CampaignRequirements | null) ?? null,
      safetyNotes: campaign.safetyNotes,
      days: campaign.days,
      shifts,
    };
  }

  /**
   * Replaces the caller's shifts in a campaign with `shiftIds`. New shifts must be on and not
   * started, in an upcoming or running campaign; nothing else blocks. Shifts left out are left,
   * except those already started, which stay.
   */
  async setMyShifts(
    campaignId: string,
    userId: string,
    input: { shiftIds: string[]; acceptConditions?: boolean },
    now = new Date(),
  ): Promise<MyRegistrationResult> {
    try {
      return await this.applyMyShifts(campaignId, userId, input, now);
    } catch (error) {
      // A concurrent identical request took the same shift first: redo against what it wrote.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return this.applyMyShifts(campaignId, userId, input, now);
      }
      throw error;
    }
  }

  private async applyMyShifts(
    campaignId: string,
    userId: string,
    input: { shiftIds: string[]; acceptConditions?: boolean },
    now: Date,
  ): Promise<MyRegistrationResult> {
    const campaign = await this.loadCampaign(campaignId);
    const wanted = [...new Set(input.shiftIds.map((id) => id.trim()).filter(Boolean))];
    const shiftById = new Map(campaign.shifts.map((s) => [s.id, s]));

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.campaignShiftRegistration.findMany({
        where: { campaignId, userId, leftAt: null },
        select: { id: true, shiftId: true },
      });
      const held = new Set(current.map((r) => r.shiftId));
      const added = wanted.filter((id) => !held.has(id));
      const dropped = current.filter((r) => !wanted.includes(r.shiftId));

      if (added.length > 0) {
        if (!CAMPAIGN_REGISTRABLE_STATUSES.includes(campaign.status)) {
          throw new HttpError(HTTP_STATUS.CAMPAIGN_NOT_REGISTRABLE);
        }
        const bad = added.filter((id) => {
          const shift = shiftById.get(id);
          return !shift || !isOpen(shift, now);
        });
        if (bad.length > 0) {
          throw new HttpError(HTTP_STATUS.SHIFT_NOT_REGISTRABLE, { shiftIds: bad });
        }
        if (input.acceptConditions !== true) {
          throw new HttpError(HTTP_STATUS.CONDITIONS_NOT_ACCEPTED);
        }
        await tx.campaignShiftRegistration.createMany({
          data: added.map((shiftId) => ({ campaignId, shiftId, userId })),
        });
      }

      const left: string[] = [];
      for (const r of dropped) {
        const shift = shiftById.get(r.shiftId);
        // A shift that has started is kept: attendance decides what happened there.
        if (shift && shift.startAt.getTime() <= now.getTime()) continue;
        await tx.campaignShiftRegistration.update({
          where: { id: r.id },
          data: { leftAt: now },
        });
        left.push(r.shiftId);
      }

      const kept = current.map((r) => r.shiftId).filter((id) => !left.includes(id));
      return { shiftIds: [...kept, ...added], added, left };
    });

    return { ...result, warnings: await this.warningsFor(campaignId, userId, result, now) };
  }

  private async warningsFor(
    campaignId: string,
    userId: string,
    result: { shiftIds: string[]; added: string[] },
    now: Date,
  ): Promise<CampaignRegistrationWarningValue[]> {
    if (result.added.length === 0) return [];
    const options = await this.getOptions(campaignId, userId, now);
    const added = options.shifts.filter((s) => result.added.includes(s.id));
    const mine = options.shifts.filter((s) => result.shiftIds.includes(s.id));
    const warnings: CampaignRegistrationWarningValue[] = [];
    const overlap =
      added.some((s) => s.conflicts.length > 0) ||
      added.some((a) => mine.some((m) => m.id !== a.id && overlaps(a, m)));
    if (overlap) warnings.push(CampaignRegistrationWarning.OVERLAP);
    if (added.some((s) => s.overMax)) warnings.push(CampaignRegistrationWarning.OVER_MAX);
    return warnings;
  }

  /**
   * Every shift with the people registered for it, to read only (spec 3.1, 4.6). Visible to the
   * people managing the campaign, its registered volunteers and platform admins.
   */
  async listByShift(
    campaignId: string,
    viewer: { userId: string; role?: string | null },
  ): Promise<ShiftRegistrations[]> {
    await campaignAccessService.assertCanViewVolunteers(campaignId, viewer.userId, viewer.role);
    const campaign = await this.loadCampaign(campaignId);
    const rows = await prisma.campaignShiftRegistration.findMany({
      where: { campaignId, leftAt: null },
      orderBy: { createdAt: "asc" },
      select: { shiftId: true, userId: true, createdAt: true },
    });
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const [profiles, checkedIn] = await Promise.all([
      fetchOrganizationOwnersByUserIds(userIds),
      campaignAttendanceRepository.findCheckInsByShift(campaignId, userIds),
    ]);

    return campaign.shifts
      .filter((s) => s.minVolunteers > 0 || rows.some((r) => r.shiftId === s.id))
      .sort(
        (a, b) =>
          a.startAt.getTime() - b.startAt.getTime() ||
          a.meetingPoint.sortOrder - b.meetingPoint.sortOrder,
      )
      .map((s) => {
        const volunteers = rows
          .filter((r) => r.shiftId === s.id)
          .map((r) => ({
            userId: r.userId,
            volunteer: getUserProfile(profiles, r.userId) ?? {
              id: r.userId,
              name: "",
              avatar: null,
              bio: null,
            },
            registeredAt: r.createdAt,
            checkedInAt: checkedIn.get(`${s.id}:${r.userId}`) ?? null,
          }));
        return {
          shiftId: s.id,
          dayId: s.dayId,
          meetingPointId: s.meetingPointId,
          meetingPointName: s.meetingPoint.name,
          startAt: s.startAt,
          endAt: s.endAt,
          minVolunteers: s.minVolunteers,
          maxVolunteers: s.maxVolunteers,
          registeredCount: volunteers.length,
          volunteers,
        };
      });
  }

  /** When managers may invite nearby residents again; null when they may now. */
  nextInviteAt(lastNearbyInviteAt: Date | null, now = new Date()): Date | null {
    if (!lastNearbyInviteAt) return null;
    const next = new Date(
      lastNearbyInviteAt.getTime() + CAMPAIGN_NEARBY_REINVITE_COOLDOWN_HOURS * HOUR_MS,
    );
    return next.getTime() > now.getTime() ? next : null;
  }

  async getNextInviteAt(campaignId: string, now = new Date()): Promise<Date | null> {
    const row = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { lastNearbyInviteAt: true },
    });
    return this.nextInviteAt(row?.lastNearbyInviteAt ?? null, now);
  }

  /**
   * Spec 3.2: managers invite residents within 5 km of every meeting point to fill short shifts,
   * at most once per `CAMPAIGN_NEARBY_REINVITE_COOLDOWN_HOURS`. Managers and people already
   * registered are left out. Returns how many were invited.
   */
  async inviteNearby(campaignId: string, userId: string, now = new Date()): Promise<{ invited: number }> {
    await campaignAccessService.assertCanManage(campaignId, userId);
    const campaign = await this.loadCampaign(campaignId);
    const open = campaign.shifts.filter((s) => isOpen(s, now));
    if (!CAMPAIGN_REGISTRABLE_STATUSES.includes(campaign.status) || open.length === 0) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_NOT_REGISTRABLE);
    }
    const retryAt = this.nextInviteAt(campaign.lastNearbyInviteAt, now);
    if (retryAt) {
      throw new HttpError(HTTP_STATUS.NEARBY_INVITE_TOO_SOON, { retryAt: retryAt.toISOString() });
    }

    // Claim the slot first, so two managers clicking together send one round.
    const claimed = await prisma.campaign.updateMany({
      where: {
        id: campaignId,
        OR: [
          { lastNearbyInviteAt: null },
          {
            lastNearbyInviteAt: {
              lte: new Date(now.getTime() - CAMPAIGN_NEARBY_REINVITE_COOLDOWN_HOURS * HOUR_MS),
            },
          },
        ],
      },
      data: { lastNearbyInviteAt: now },
    });
    if (claimed.count === 0) {
      throw new HttpError(HTTP_STATUS.NEARBY_INVITE_TOO_SOON);
    }

    const counts = await campaignRegistrationRepository.countByShift(campaignId);
    const shortBy = open.reduce(
      (sum, s) => sum + Math.max(0, s.minVolunteers - (counts.get(s.id) ?? 0)),
      0,
    );
    const points = new Map<string, { latitude: number; longitude: number }>();
    for (const s of open) {
      points.set(s.meetingPointId, {
        latitude: s.meetingPoint.latitude,
        longitude: s.meetingPoint.longitude,
      });
    }
    const registered = await campaignRegistrationRepository.findRegisteredUserIds(campaignId);
    const recipients = await findNearbyUserIds(
      [...points.values()],
      [
        ...(campaign.createdBy ? [campaign.createdBy] : []),
        ...campaign.campaignManagers.map((m) => m.userId),
        ...registered,
      ],
    );
    if (recipients.length > 0) {
      try {
        await enqueueWebsiteNotificationsToUsers({
          kind: "CAMPAIGN_JOIN_INVITE",
          userIds: recipients,
          payload: {
            campaignId,
            shortBy: String(shortBy),
            ...campaignTitleNotificationPayload(campaign),
          },
        });
      } catch (error) {
        // Nothing went out: give the slot back so the manager can try again right away.
        await prisma.campaign.updateMany({
          where: { id: campaignId, lastNearbyInviteAt: now },
          data: { lastNearbyInviteAt: campaign.lastNearbyInviteAt },
        });
        throw error;
      }
    }
    return { invited: recipients.length };
  }

  /**
   * Spec 3.2: a manager turns a shift off before it starts. Its registrations end (marked as
   * closed by the shift, not left by the volunteer) and those volunteers are told to pick another
   * shift. A day keeps at least one shift that runs; dropping the whole day is cancelling it.
   */
  async closeShift(
    campaignId: string,
    shiftId: string,
    userId: string,
    now = new Date(),
  ): Promise<{ notified: number }> {
    await campaignAccessService.assertCanManage(campaignId, userId);
    const campaign = await this.loadCampaign(campaignId);
    if (!CAMPAIGN_REGISTRABLE_STATUSES.includes(campaign.status)) {
      throw new HttpError(HTTP_STATUS.CAMPAIGN_NOT_EDITABLE);
    }
    const shift = campaign.shifts.find((s) => s.id === shiftId && s.minVolunteers > 0);
    if (!shift) {
      throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Shift not found"));
    }
    if (shift.startAt.getTime() <= now.getTime()) {
      throw new HttpError(HTTP_STATUS.SHIFT_ALREADY_STARTED);
    }
    const othersOnDay = campaign.shifts.filter(
      (s) => s.dayId === shift.dayId && s.id !== shift.id && s.minVolunteers > 0,
    );
    if (othersOnDay.length === 0) {
      throw new HttpError(HTTP_STATUS.DAY_NEEDS_ACTIVE_SHIFT);
    }

    const shiftLabel = `${shift.meetingPoint.name || `#${shift.meetingPoint.sortOrder + 1}`} ${localHourMinute(shift.startAt)}`;
    const volunteerIds = await prisma.$transaction(async (tx) => {
      const live = await tx.campaignShiftRegistration.findMany({
        where: { shiftId, leftAt: null },
        select: { userId: true },
      });
      await tx.campaignShift.update({
        where: { id: shiftId },
        data: { minVolunteers: 0, maxVolunteers: null, overMaxNotifiedAt: null },
      });
      await tx.campaignShiftRegistration.updateMany({
        where: { shiftId, leftAt: null },
        data: { leftAt: now, closedByShift: true },
      });
      await tx.campaignStatusLog.create({
        data: {
          campaignId,
          type: "EDIT",
          event: "close_shift",
          actorId: userId,
          actorRole: "manager",
          reason: null,
          changes: { shiftId, volunteers: live.length },
        },
      });
      const userIds = [...new Set(live.map((r) => r.userId))];
      if (userIds.length > 0) {
        // Through the outbox, so the notice survives notification-service being down.
        await emitOutbox(tx, {
          aggregateType: "campaign",
          aggregateId: campaignId,
          eventType: OutboxEventType.WEBSITE_NOTIFICATION,
          dedupKey: `CAMPAIGN_SHIFT_CLOSED:${shiftId}`,
          payload: {
            kind: "CAMPAIGN_SHIFT_CLOSED",
            userIds,
            payload: {
              campaignId,
              day: localDayMonth(shift.startAt),
              shift: shiftLabel,
              ...campaignTitleNotificationPayload(campaign),
            },
          },
        });
      }
      return userIds;
    });

    return { notified: volunteerIds.length };
  }

  /**
   * People registered for at least one shift, one row each. Visible to the people managing the
   * campaign, its volunteers and platform admins.
   */
  async listVolunteers(
    campaignId: string,
    viewer: { userId: string; role?: string | null },
    query: { page?: number; limit?: number; sortOrder?: "asc" | "desc"; volunteerId?: string },
  ) {
    await campaignAccessService.assertCanViewVolunteers(campaignId, viewer.userId, viewer.role);
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const { rows, total } = await campaignRegistrationRepository.findVolunteersPaginated(
      campaignId,
      { userId: query.volunteerId },
      { skip: (page - 1) * limit, take: limit, sortOrder: query.sortOrder ?? "desc" },
    );
    const userIds = rows.map((r) => r.userId);
    const [profiles, checkedInAtByUserId] = await Promise.all([
      fetchOrganizationOwnersByUserIds(userIds),
      campaignAttendanceRepository.findCheckedInAtByCampaignAndUserIds(campaignId, userIds),
    ]);
    return {
      volunteers: rows.map((r) => ({
        id: r.userId,
        campaignId,
        volunteerId: r.userId,
        volunteer: getUserProfile(profiles, r.userId) ?? {
          id: r.userId,
          name: "",
          avatar: null,
          bio: null,
        },
        createdAt: r.registeredAt,
        checkedInAt: checkedInAtByUserId.get(r.userId) ?? null,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}

export const campaignRegistrationService = new CampaignRegistrationService();
