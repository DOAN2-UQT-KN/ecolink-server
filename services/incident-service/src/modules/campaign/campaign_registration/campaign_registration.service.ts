import {
  CAMPAIGN_ABSENCE_WARN_COUNT,
  CAMPAIGN_FREE_LEAVE_HOURS,
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
import { campaignRegistrationRepository } from "./campaign_registration.repository";

const HOUR_MS = 60 * 60 * 1000;

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
  absenceCount: number;
  manyAbsences: boolean;
}

export interface MyRegistrationResult {
  shiftIds: string[];
  added: string[];
  left: string[];
  /** Left shifts that started within the free-leave window. */
  lateLeft: string[];
  warnings: CampaignRegistrationWarningValue[];
}

export interface RegisteredShiftVolunteer {
  userId: string;
  volunteer: OrganizationOwnerResponse;
  registeredAt: Date;
  absenceCount: number;
  lateLeaveCount: number;
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
 * Per-shift registration (spec 3.1): effective at once, no approval and no cap. Overlaps, a
 * record of absences and full shifts only warn. Unticking a shift is leaving it (3.3): it is
 * recorded as a late leave inside the free-leave window.
 */
export class CampaignRegistrationService {
  private async loadCampaign(campaignId: string) {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, deletedAt: null },
      select: {
        id: true,
        title: true,
        status: true,
        requirements: true,
        safetyNotes: true,
        days: { orderBy: { startAt: "asc" }, select: { id: true, startAt: true, endAt: true } },
        shifts: {
          orderBy: { startAt: "asc" },
          include: {
            meetingPoint: { select: { name: true, detailAddress: true, sortOrder: true } },
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
    const [counts, mine, absences] = await Promise.all([
      campaignRegistrationRepository.countByShift(campaignId),
      campaignRegistrationRepository.findMyShiftIds(campaignId, userId),
      campaignRegistrationRepository.countRecentAbsences([userId], now),
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
    const absenceCount = absences.get(userId) ?? 0;
    return {
      registrable: statusOpen && openCount > 0,
      reason: !statusOpen ? "STATUS" : openCount === 0 ? "NO_SHIFT" : null,
      requirements: (campaign.requirements as CampaignRequirements | null) ?? null,
      safetyNotes: campaign.safetyNotes,
      days: campaign.days,
      shifts,
      absenceCount,
      manyAbsences: absenceCount >= CAMPAIGN_ABSENCE_WARN_COUNT,
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
      const lateLeft: string[] = [];
      for (const r of dropped) {
        const shift = shiftById.get(r.shiftId);
        // A shift that has started is kept: attendance decides what happened there.
        if (shift && shift.startAt.getTime() <= now.getTime()) continue;
        const late =
          shift != null &&
          shift.startAt.getTime() - now.getTime() < CAMPAIGN_FREE_LEAVE_HOURS * HOUR_MS;
        await tx.campaignShiftRegistration.update({
          where: { id: r.id },
          data: { leftAt: now, lateLeave: late },
        });
        left.push(r.shiftId);
        if (late) lateLeft.push(r.shiftId);
      }

      const kept = current.map((r) => r.shiftId).filter((id) => !left.includes(id));
      return { shiftIds: [...kept, ...added], added, left, lateLeft };
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
    if (options.manyAbsences) warnings.push(CampaignRegistrationWarning.MANY_ABSENCES);
    if (added.some((s) => s.overMax)) warnings.push(CampaignRegistrationWarning.OVER_MAX);
    return warnings;
  }

  /** Managers: every shift with the people registered for it and their record. */
  async listForManager(campaignId: string, userId: string, now = new Date()): Promise<ShiftRegistrations[]> {
    await campaignAccessService.assertCanManage(campaignId, userId);
    const campaign = await this.loadCampaign(campaignId);
    const rows = await prisma.campaignShiftRegistration.findMany({
      where: { campaignId, leftAt: null },
      orderBy: { createdAt: "asc" },
      select: { shiftId: true, userId: true, createdAt: true },
    });
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const [profiles, absences, lateLeaves] = await Promise.all([
      fetchOrganizationOwnersByUserIds(userIds),
      campaignRegistrationRepository.countRecentAbsences(userIds, now),
      campaignRegistrationRepository.countRecentLateLeaves(userIds, now),
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
            absenceCount: absences.get(r.userId) ?? 0,
            lateLeaveCount: lateLeaves.get(r.userId) ?? 0,
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
