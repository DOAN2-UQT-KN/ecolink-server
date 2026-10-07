import { Prisma } from "@prisma/client";
import {
  SOS_ABUSE_THRESHOLD,
  SOS_ABUSE_WINDOW_DAYS,
  SOS_ARRIVED_RADIUS_M,
  SOS_DUPLICATE_RADIUS_M,
  SOS_HAZARD_KINDS,
  SOS_INVITE_RADIUS_KM,
  SOS_LIVE_STATES,
  SOS_MANPOWER_TTL_H,
  SOS_MANPOWER_TTL_H_MAX,
  SOS_MANPOWER_TTL_H_MIN,
  SOS_MEDICAL_CONSCIOUSNESS,
  SOS_PEOPLE_NEEDED_MAX,
  SOS_PEOPLE_NEEDED_MIN,
  SOS_RESOLUTION_CODE,
  SOS_RESPONDER_STATUS,
  SOS_STATE,
  SOS_TOOLS,
  SOS_TYPE,
  type SosReporterRoleValue,
  type SosResolutionCodeValue,
  type SosStateValue,
  type SosTypeValue,
} from "@da2/constants";
import prisma from "../../config/prisma.client";
import { GlobalStatus } from "../../constants/status.enum";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { campaignAccessService, isPlatformAdmin } from "../campaign/campaign-access.service";
import { getCampaignAdminNotifyUserIds } from "../campaign/campaign-completion-admin-notify.config";
import { haversineKm } from "../campaign/campaign-submit-validation";
import { effectiveEnd } from "../campaign/campaign_shift_result/shift-status";
import {
  fetchOrganizationOwnersByUserIds,
  fetchUserVoteProfile,
  getUserProfile,
} from "../organization/identity-user.client";
import {
  SOS_KIND,
  closeResponders,
  dispatchOnCreate,
  loadSosContext,
  sendSosNotice,
} from "./sos-dispatch";
import { resolveSosEligibility, sosHourlyLimit, sosShiftName } from "./sos-eligibility";
import type {
  CreateSosRequest,
  SosActor,
  SosDetail,
  SosListQuery,
  SosListResult,
  SosSummary,
} from "./sos.dto";

type Tx = Prisma.TransactionClient;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ACTIVE_RESPONSES: string[] = [SOS_RESPONDER_STATUS.ON_THE_WAY, SOS_RESPONDER_STATUS.ARRIVED];

const SOS_INCLUDE = {
  campaign: {
    select: {
      id: true,
      title: true,
      organizationId: true,
      createdBy: true,
      contactName: true,
      contactPhone: true,
      safetyNotes: true,
    },
  },
  shift: { include: { meetingPoint: true } },
  meetingPoint: true,
  responders: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.SosInclude;

type SosRow = Prisma.SosGetPayload<{ include: typeof SOS_INCLUDE }>;
const SUMMARY_INCLUDE = {
  responders: true,
  campaign: { select: { id: true, title: true, organizationId: true, createdBy: true } },
  shift: { select: { leaderUserId: true } },
} satisfies Prisma.SosInclude;

type SummaryRow = Prisma.SosGetPayload<{ include: { responders: true } }> & { campaign: { title: string } };
type ReporterProfile = { name?: string | null; avatar?: string | null } | undefined;

const isLive = (state: string) => (SOS_LIVE_STATES as string[]).includes(state);

/** Manpower lifetime: SOS_MANPOWER_TTL_H, or env `SOS_MANPOWER_TTL_H` within 3–6 hours. */
function manpowerTtlMs(): number {
  const raw = Number(process.env.SOS_MANPOWER_TTL_H);
  const hours = Number.isFinite(raw) && raw > 0
    ? Math.min(SOS_MANPOWER_TTL_H_MAX, Math.max(SOS_MANPOWER_TTL_H_MIN, raw))
    : SOS_MANPOWER_TTL_H;
  return hours * HOUR_MS;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** The required fields of each type (spec "Phân loại SOS"); anything else is dropped. */
export function normalizeSosDetails(
  type: SosTypeValue,
  raw: Record<string, unknown> | null | undefined,
  photoUrls: string[],
): Record<string, unknown> {
  const d = raw ?? {};
  const invalid = (message: string) =>
    new HttpError(HTTP_STATUS.SOS_DETAILS_INVALID.withMessage(message));
  if (type === SOS_TYPE.MANPOWER) {
    const people = d.peopleNeeded ?? null;
    if (
      people !== null &&
      (!isInt(people) || people < SOS_PEOPLE_NEEDED_MIN || people > SOS_PEOPLE_NEEDED_MAX)
    ) {
      throw invalid(`people_needed must be ${SOS_PEOPLE_NEEDED_MIN}–${SOS_PEOPLE_NEEDED_MAX}`);
    }
    const tools = d.tools ?? [];
    if (!Array.isArray(tools) || tools.some((t) => !(SOS_TOOLS as readonly unknown[]).includes(t))) {
      throw invalid(`tools must be among ${SOS_TOOLS.join(", ")}`);
    }
    const note = typeof d.toolsNote === "string" ? d.toolsNote.trim().slice(0, 500) : "";
    if (people === null && tools.length === 0) {
      throw invalid("people_needed or tools is required");
    }
    return { peopleNeeded: people, tools: [...new Set(tools as string[])], toolsNote: note || null };
  }
  if (type === SOS_TYPE.HAZARD) {
    // `hazard_kind` (a single string) is still accepted from older clients.
    const kinds = Array.isArray(d.hazardKinds) ? d.hazardKinds : d.hazardKind != null ? [d.hazardKind] : [];
    if (kinds.length === 0 || kinds.some((k) => !(SOS_HAZARD_KINDS as readonly unknown[]).includes(k))) {
      throw invalid(`hazard_kinds must be one or more of ${SOS_HAZARD_KINDS.join(", ")}`);
    }
    if (photoUrls.length === 0) throw new HttpError(HTTP_STATUS.SOS_PHOTO_REQUIRED);
    return { hazardKinds: [...new Set(kinds as string[])] };
  }
  if (!(SOS_MEDICAL_CONSCIOUSNESS as readonly unknown[]).includes(d.consciousness)) {
    throw invalid("consciousness must be conscious or unconscious");
  }
  if (!isInt(d.affected) || d.affected < 1 || d.affected > 1000) {
    throw invalid("affected must be at least 1");
  }
  return { consciousness: d.consciousness, affected: d.affected };
}

const peopleNeededOf = (details: unknown): number | null => {
  const v = (details as Record<string, unknown> | null)?.peopleNeeded;
  return typeof v === "number" ? v : null;
};

/**
 * `privileged` (admin or the SOS's team) adds the reporter and the phone; everyone else gets null.
 */
function toSummary(
  row: SummaryRow,
  viewerId: string | null,
  privileged = false,
  reporterProfile?: ReporterProfile,
): SosSummary {
  const mine = viewerId ? row.responders.find((r) => r.userId === viewerId) : undefined;
  return {
    id: row.id,
    campaignId: row.campaignId,
    campaignTitle: row.campaign.title,
    shiftId: row.shiftId,
    meetingPointId: row.meetingPointId,
    type: row.type as SosTypeValue,
    state: row.state as SosStateValue,
    status: row.status,
    latitude: row.latitude,
    longitude: row.longitude,
    createdAt: row.createdAt,
    peopleNeeded: peopleNeededOf(row.details),
    onTheWayCount: row.responders.filter((r) => r.status === SOS_RESPONDER_STATUS.ON_THE_WAY).length,
    arrivedCount: row.responders.filter((r) => r.status === SOS_RESPONDER_STATUS.ARRIVED).length,
    isMine: viewerId != null && row.createdBy === viewerId,
    myResponse:
      mine && ACTIVE_RESPONSES.includes(mine.status) ? (mine.status as "on_the_way" | "arrived") : null,
    reporterRole: row.reporterRole as SosReporterRoleValue | null,
    resolvedAt: row.resolvedAt,
    resolutionCode: row.resolutionCode as SosResolutionCodeValue | null,
    phone: privileged ? row.phone : null,
    reporter:
      privileged && row.createdBy
        ? { id: row.createdBy, name: reporterProfile?.name ?? null, avatar: reporterProfile?.avatar ?? null }
        : null,
  };
}

export class SosService {
  private async load(id: number, db: Tx | typeof prisma = prisma): Promise<SosRow> {
    const row = await db.sos.findFirst({ where: { id, deletedAt: null }, include: SOS_INCLUDE });
    if (!row) throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("SOS not found"));
    return row;
  }

  /** The campaign's team for this SOS: whoever manages the campaign, or leads the SOS's shift. */
  private async isTeam(row: SosRow, userId: string): Promise<boolean> {
    if (row.shift?.leaderUserId === userId) return true;
    return campaignAccessService.canManage(row.campaign, userId);
  }

  /**
   * Filtered by viewer (spec "Quyền riêng tư"): the reporter's phone and name for the team and
   * admins; responder names for the reporter, the team and admins; medical details for the team,
   * responders, the reporter and admins; the campaign's contact for the team, responders and admins.
   */
  private async toDetail(row: SosRow, actor: SosActor): Promise<SosDetail> {
    const userId = actor.userId;
    const isAdmin = isPlatformAdmin(actor.role);
    const isCreator = row.createdBy === userId;
    const isTeam = await this.isTeam(row, userId);
    const privileged = isTeam || isAdmin;
    const mine = row.responders.find((r) => r.userId === userId);
    const responding = mine != null && ACTIVE_RESPONSES.includes(mine.status);
    const live = isLive(row.state);
    const active = row.responders.filter((r) => ACTIVE_RESPONSES.includes(r.status));
    const seeResponders = isCreator || privileged;

    const profiles = await fetchOrganizationOwnersByUserIds([
      ...(privileged && row.createdBy ? [row.createdBy] : []),
      ...(seeResponders ? active.map((r) => r.userId) : []),
    ]);
    const details = { ...((row.details ?? {}) as Record<string, unknown>) };
    // SOS raised before hazard kinds became a list.
    if (typeof details.hazardKind === "string") {
      details.hazardKinds ??= [details.hazardKind];
      delete details.hazardKind;
    }
    if (row.type === SOS_TYPE.MEDICAL && !(privileged || responding || isCreator)) {
      details.consciousness = null;
      details.affected = null;
    }
    const reporterProfile = row.createdBy ? getUserProfile(profiles, row.createdBy) : undefined;
    const point = row.meetingPoint ?? row.shift?.meetingPoint ?? null;
    const respondable = row.type !== SOS_TYPE.HAZARD && (row.state === SOS_STATE.OPEN || row.state === SOS_STATE.HELPING);

    return {
      ...toSummary(row, userId, privileged, reporterProfile),
      campaign: {
        id: row.campaign.id,
        title: row.campaign.title,
        contactName: privileged || responding ? row.campaign.contactName : null,
        contactPhone: privileged || responding ? row.campaign.contactPhone : null,
        safetyNotes: row.campaign.safetyNotes,
      },
      shift: row.shift
        ? { id: row.shift.id, name: sosShiftName(row.shift), startAt: row.shift.startAt, endAt: effectiveEnd(row.shift) }
        : null,
      meetingPoint: point
        ? { id: point.id, name: point.name, latitude: point.latitude, longitude: point.longitude }
        : null,
      details,
      description: row.content,
      photoUrls: row.photoUrls,
      responders: seeResponders
        ? active.map((r) => {
            const p = getUserProfile(profiles, r.userId);
            return {
              userId: r.userId,
              name: p?.name ?? null,
              avatar: p?.avatar ?? null,
              status: r.status as "on_the_way" | "arrived",
              updatedAt: r.updatedAt,
            };
          })
        : [],
      expiresAt: row.expiresAt,
      escalatedAt: row.escalatedAt,
      radiusKm: row.radiusKm,
      resolvedBy: row.resolvedBy,
      resolutionNote: row.resolutionNote,
      locationUpdatedAt: row.locationUpdatedAt,
      permissions: {
        canRespond: respondable && !isCreator && !responding,
        canCancelResponse: live && responding,
        canUpdateLocation: live && isCreator,
        canResolve: live && (isCreator || privileged),
      },
      viewerIsTeam: isTeam,
    };
  }

  async getDetail(id: number, actor: SosActor): Promise<SosDetail> {
    return this.toDetail(await this.load(id), actor);
  }

  /**
   * `POST /sos`: who may raise it (`sos-eligibility`), 3 per hour, details by type. Located at the
   * reporter's GPS, else the shift's meeting point; the phone comes from the reporter's profile.
   * Manpower expires 4 h later or when its shift ends, whichever comes first.
   */
  async create(body: CreateSosRequest, actor: SosActor, now = new Date()): Promise<SosDetail> {
    const photoUrls = (body.photoUrls ?? []).map((u) => u.trim()).filter(Boolean);
    const details = normalizeSosDetails(body.type, body.details, photoUrls);
    const gps =
      body.latitude != null && body.longitude != null
        ? { latitude: body.latitude, longitude: body.longitude }
        : null;

    const elig = await resolveSosEligibility(body.campaignId, actor.userId, gps ?? {}, now);
    if (!elig.canRaise || !elig.role) {
      throw new HttpError(HTTP_STATUS.SOS_NOT_ELIGIBLE, { reason: elig.reason });
    }
    if (elig.hourlyRemaining !== null && elig.hourlyRemaining <= 0) {
      throw new HttpError(HTTP_STATUS.SOS_RATE_LIMIT);
    }

    let shift = body.shiftId ? elig.running.find((s) => s.id === body.shiftId) : undefined;
    if (body.shiftId && !shift) {
      throw new HttpError(HTTP_STATUS.SOS_NOT_ELIGIBLE, { reason: "shift_not_allowed" });
    }
    if (!shift) {
      shift = gps
        ? [...elig.running].sort((a, b) => haversineKm(gps, a.meetingPoint) - haversineKm(gps, b.meetingPoint))[0]
        : elig.running[0];
    }
    const point = shift.meetingPoint;
    const at = gps ?? { latitude: point.latitude, longitude: point.longitude };
    const phone =
      elig.phone !== undefined
        ? elig.phone
        : ((await fetchUserVoteProfile({ userId: actor.userId, ...at }))?.phoneNumber ?? null);
    const urgent = body.type === SOS_TYPE.HAZARD || body.type === SOS_TYPE.MEDICAL;

    const id = await prisma.$transaction(async (tx) => {
      const limit = sosHourlyLimit();
      if (limit > 0) {
        // Serializes one person's SOS so the hourly count holds under double taps.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sos:${actor.userId}`}))`;
        const used = await tx.sos.count({
          where: { createdBy: actor.userId, deletedAt: null, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
        });
        if (used >= limit) {
          throw new HttpError(HTTP_STATUS.SOS_RATE_LIMIT);
        }
      }
      const sos = await tx.sos.create({
        data: {
          campaignId: body.campaignId,
          type: body.type,
          details: details as Prisma.InputJsonValue,
          state: SOS_STATE.OPEN,
          content: body.description?.trim() || null,
          phone,
          address: point.detailAddress ?? "",
          detailAddress: point.detailAddress,
          photoUrls,
          shiftId: shift.id,
          meetingPointId: point.id,
          reporterRole: elig.role,
          latitude: at.latitude,
          longitude: at.longitude,
          radiusKm: SOS_INVITE_RADIUS_KM,
          expiresAt:
            body.type === SOS_TYPE.MANPOWER
              ? new Date(Math.min(now.getTime() + manpowerTtlMs(), effectiveEnd(shift).getTime()))
              : null,
          // Medical tells the owners at once; hazard / medical send priority 2 at once.
          ownerNotifiedAt: body.type === SOS_TYPE.MEDICAL ? now : null,
          tier2SentAt: urgent ? now : null,
          status: GlobalStatus._STATUS_ACTIVE,
          createdBy: actor.userId,
          createdAt: now,
        },
      });
      await dispatchOnCreate(tx, sos, await loadSosContext(tx, sos), now);
      return sos.id;
    });
    return this.getDetail(id, actor);
  }

  /** Open SOS of the same type within 200 m, so the client can suggest it instead of a new one. */
  async duplicates(
    params: { campaignId: string; type: SosTypeValue; latitude: number; longitude: number },
    actor: SosActor,
  ): Promise<SosSummary[]> {
    const rows = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT id
      FROM sos
      WHERE deleted_at IS NULL
        AND campaign_id = ${params.campaignId}::uuid
        AND type = ${params.type}
        AND state IN (${Prisma.join(SOS_LIVE_STATES)})
        AND ST_DWithin(
          ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
          ST_SetSRID(ST_MakePoint(${params.longitude}, ${params.latitude}), 4326)::geography,
          ${SOS_DUPLICATE_RADIUS_M}
        )
      ORDER BY created_at DESC
      LIMIT 10`;
    return this.summaries(rows.map((r) => r.id), actor);
  }

  /**
   * Rows in the order of `ids`. The reporter and the phone only for an admin or the SOS's team
   * (same rule as `isTeam`): one `canManage` per campaign and one profile batch per call.
   */
  private async summaries(ids: number[], actor: SosActor | null): Promise<SosSummary[]> {
    if (ids.length === 0) return [];
    const rows = await prisma.sos.findMany({
      where: { id: { in: ids } },
      include: SUMMARY_INCLUDE,
    });
    const viewerId = actor?.userId ?? null;
    const isAdmin = isPlatformAdmin(actor?.role);
    const manages = new Map<string, Promise<boolean>>();
    const privileged = new Map<number, boolean>();
    if (viewerId) {
      await Promise.all(
        rows.map(async (row) => {
          let team = isAdmin || row.shift?.leaderUserId === viewerId;
          if (!team) {
            let check = manages.get(row.campaignId);
            if (!check) {
              check = campaignAccessService.canManage(row.campaign, viewerId);
              manages.set(row.campaignId, check);
            }
            team = await check;
          }
          privileged.set(row.id, team);
        }),
      );
    }
    const reporterIds = [
      ...new Set(rows.filter((r) => privileged.get(r.id) && r.createdBy).map((r) => r.createdBy as string)),
    ];
    const profiles = reporterIds.length > 0 ? await fetchOrganizationOwnersByUserIds(reporterIds) : null;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      const priv = privileged.get(id) ?? false;
      const profile = priv && profiles && row.createdBy ? getUserProfile(profiles, row.createdBy) : undefined;
      return [toSummary(row, viewerId, priv, profile)];
    });
  }

  /**
   * Map / list: live SOS by default; escalated first, then medical, then newest. Filters: type,
   * `search` (campaign title, or the SOS id when it is a whole number). Position, type, state, the
   * counter and the public closing fields for anyone; the reporter and the phone only for an admin
   * or the SOS's team (ISSUE-S14).
   */
  async list(query: SosListQuery, actor: SosActor | null): Promise<SosListResult> {
    const { page, limit } = query;
    const conds: Prisma.Sql[] = [Prisma.sql`deleted_at IS NULL`];
    if (query.states.length > 0) conds.push(Prisma.sql`state IN (${Prisma.join(query.states)})`);
    if (query.campaignId) conds.push(Prisma.sql`campaign_id = ${query.campaignId}::uuid`);
    if (query.type) conds.push(Prisma.sql`type = ${query.type}`);
    const search = query.search?.trim();
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const byTitle = Prisma.sql`EXISTS (
        SELECT 1 FROM campaigns c WHERE c.id = sos.campaign_id AND c.title ILIKE ${pattern}
      )`;
      const asId = /^\d{1,9}$/.test(search) ? Number(search) : null;
      conds.push(asId !== null ? Prisma.sql`(${byTitle} OR sos.id = ${asId})` : byTitle);
    }
    if (query.latitude !== undefined && query.longitude !== undefined) {
      conds.push(Prisma.sql`ST_DWithin(
        ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${query.longitude}, ${query.latitude}), 4326)::geography,
        ${query.maxDistance ?? 50_000}
      )`);
    }
    const where = Prisma.join(conds, " AND ");
    const [rows, count] = await Promise.all([
      prisma.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM sos WHERE ${where}
        ORDER BY (state = ${SOS_STATE.ESCALATED}) DESC, (type = ${SOS_TYPE.MEDICAL}) DESC,
          created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM sos WHERE ${where}`,
    ]);
    const items = await this.summaries(rows.map((r) => r.id), actor);
    const total = Number(count[0]?.count ?? 0);
    return { items, sos: items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * "Tôi tới giúp ngay": manpower and medical only, open or helping, not the reporter; one SOS on
   * the way at a time. The first one turns the SOS to helping.
   */
  async respond(id: number, actor: SosActor, now = new Date()): Promise<SosDetail> {
    await prisma.$transaction(async (tx) => {
      const sos = await this.load(id, tx);
      if (sos.state !== SOS_STATE.OPEN && sos.state !== SOS_STATE.HELPING) {
        throw new HttpError(HTTP_STATUS.SOS_CLOSED);
      }
      if (sos.type === SOS_TYPE.HAZARD || sos.createdBy === actor.userId) {
        throw new HttpError(HTTP_STATUS.SOS_RESPOND_NOT_ALLOWED);
      }
      const mine = sos.responders.find((r) => r.userId === actor.userId);
      if (mine && ACTIVE_RESPONSES.includes(mine.status)) return;
      const elsewhere = await tx.sosResponder.findFirst({
        where: { userId: actor.userId, status: SOS_RESPONDER_STATUS.ON_THE_WAY, sosId: { not: id } },
      });
      if (elsewhere) throw new HttpError(HTTP_STATUS.SOS_ALREADY_RESPONDING);
      try {
        await tx.sosResponder.upsert({
          where: { sosId_userId: { sosId: id, userId: actor.userId } },
          create: { sosId: id, userId: actor.userId, status: SOS_RESPONDER_STATUS.ON_THE_WAY, createdAt: now },
          update: { status: SOS_RESPONDER_STATUS.ON_THE_WAY, cancelledAt: null, arrivedAt: null },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new HttpError(HTTP_STATUS.SOS_ALREADY_RESPONDING);
        }
        throw error;
      }
      await tx.sos.updateMany({
        where: { id, state: SOS_STATE.OPEN },
        data: { state: SOS_STATE.HELPING },
      });
    });
    return this.getDetail(id, actor);
  }

  /** "Không tới được nữa": with nobody left on the way or there, the SOS is open again. */
  async cancelResponse(id: number, actor: SosActor, now = new Date()): Promise<SosDetail> {
    await prisma.$transaction(async (tx) => {
      const sos = await this.load(id, tx);
      const mine = sos.responders.find((r) => r.userId === actor.userId);
      if (!mine || !ACTIVE_RESPONSES.includes(mine.status)) return;
      await tx.sosResponder.update({
        where: { id: mine.id },
        data: { status: SOS_RESPONDER_STATUS.CANCELLED, cancelledAt: now },
      });
      const left = await tx.sosResponder.count({ where: { sosId: id, status: { in: ACTIVE_RESPONSES } } });
      if (left === 0) {
        await tx.sos.updateMany({ where: { id, state: SOS_STATE.HELPING }, data: { state: SOS_STATE.OPEN } });
      }
    });
    return this.getDetail(id, actor);
  }

  /** The responder's position (every 30 s from the client): within 50 m they have arrived. */
  async updateResponderLocation(
    id: number,
    actor: SosActor,
    at: { latitude: number; longitude: number },
    now = new Date(),
  ): Promise<SosDetail> {
    const sos = await this.load(id);
    if (!isLive(sos.state)) throw new HttpError(HTTP_STATUS.SOS_CLOSED);
    const mine = sos.responders.find((r) => r.userId === actor.userId);
    if (!mine || !ACTIVE_RESPONSES.includes(mine.status)) {
      throw new HttpError(HTTP_STATUS.SOS_RESPOND_NOT_ALLOWED);
    }
    const distanceM = Math.round(haversineKm(at, sos) * 1000);
    const arrives = mine.status === SOS_RESPONDER_STATUS.ON_THE_WAY && distanceM <= SOS_ARRIVED_RADIUS_M;
    await prisma.sosResponder.update({
      where: { id: mine.id },
      data: {
        distanceM,
        ...(arrives ? { status: SOS_RESPONDER_STATUS.ARRIVED, arrivedAt: now } : {}),
      },
    });
    return this.getDetail(id, actor);
  }

  /** The reporter moves the SOS (e.g. the injured carried to the road); the people on the way hear. */
  async updateLocation(
    id: number,
    actor: SosActor,
    at: { latitude: number; longitude: number },
    now = new Date(),
  ): Promise<SosDetail> {
    await prisma.$transaction(async (tx) => {
      const current = await this.load(id, tx);
      if (current.createdBy !== actor.userId) throw new HttpError(HTTP_STATUS.SOS_PERMISSION_DENIED);
      if (!isLive(current.state)) throw new HttpError(HTTP_STATUS.SOS_CLOSED);
      const sos = await tx.sos.update({
        where: { id },
        data: { latitude: at.latitude, longitude: at.longitude, locationUpdatedAt: now, updatedBy: actor.userId },
      });
      const onTheWay = current.responders
        .filter((r) => r.status === SOS_RESPONDER_STATUS.ON_THE_WAY)
        .map((r) => r.userId);
      await sendSosNotice(tx, sos, await loadSosContext(tx, sos), {
        kind: SOS_KIND.LOCATION_CHANGED,
        userIds: onTheWay,
        dedupKey: `${SOS_KIND.LOCATION_CHANGED}:${id}:${now.getTime()}`,
      });
    });
    return this.getDetail(id, actor);
  }

  /**
   * "Đã giải quyết": the reporter, the team (shift leader, managers) or an admin. The people on
   * the way hear "no need to come"; a reporter with 3 SOS closed as false alarm / not real in 30
   * days is sent to the admins for review. `idempotent` (legacy `/solved`): closing a resolved SOS
   * again returns it instead of 409.
   */
  async resolve(
    id: number,
    actor: SosActor,
    input: { code: SosResolutionCodeValue; note?: string | null },
    now = new Date(),
    opts: { idempotent?: boolean } = {},
  ): Promise<SosDetail> {
    const current = await this.load(id);
    const allowed =
      current.createdBy === actor.userId ||
      isPlatformAdmin(actor.role) ||
      (await this.isTeam(current, actor.userId));
    if (!allowed) throw new HttpError(HTTP_STATUS.SOS_PERMISSION_DENIED);
    if (!isLive(current.state)) {
      if (opts.idempotent && current.state === SOS_STATE.RESOLVED) return this.toDetail(current, actor);
      throw new HttpError(HTTP_STATUS.SOS_CLOSED);
    }

    await prisma.$transaction(async (tx) => {
      const updated = await tx.sos.updateMany({
        where: { id, state: { in: SOS_LIVE_STATES } },
        data: {
          state: SOS_STATE.RESOLVED,
          status: GlobalStatus._STATUS_COMPLETED,
          resolvedBy: actor.userId,
          resolvedAt: now,
          resolutionCode: input.code,
          resolutionNote: input.note?.trim() || null,
          updatedBy: actor.userId,
        },
      });
      if (updated.count === 0) throw new HttpError(HTTP_STATUS.SOS_CLOSED);
      const sos = await tx.sos.findUniqueOrThrow({ where: { id } });
      const ctx = await loadSosContext(tx, sos);
      await closeResponders(tx, sos, ctx, SOS_KIND.NO_LONGER_NEEDED, now);

      if (
        sos.createdBy &&
        (input.code === SOS_RESOLUTION_CODE.FALSE_ALARM || input.code === SOS_RESOLUTION_CODE.NOT_REAL)
      ) {
        const count = await tx.sos.count({
          where: {
            createdBy: sos.createdBy,
            resolutionCode: { in: [SOS_RESOLUTION_CODE.FALSE_ALARM, SOS_RESOLUTION_CODE.NOT_REAL] },
            resolvedAt: { gte: new Date(now.getTime() - SOS_ABUSE_WINDOW_DAYS * DAY_MS) },
          },
        });
        if (count >= SOS_ABUSE_THRESHOLD) {
          await sendSosNotice(tx, sos, ctx, {
            kind: SOS_KIND.ABUSE_REVIEW,
            userIds: getCampaignAdminNotifyUserIds(),
            dedupKey: `${SOS_KIND.ABUSE_REVIEW}:${sos.id}`,
            extra: { reporterId: sos.createdBy, count: String(count) },
          });
        }
      }
    });
    return this.getDetail(id, actor);
  }

  /** Legacy `PUT /sos/:id/solved`: resolve as handled. */
  async solveSos(id: number, actor: SosActor, now = new Date()): Promise<SosDetail> {
    return this.resolve(id, actor, { code: SOS_RESOLUTION_CODE.HANDLED }, now, { idempotent: true });
  }
}

export const sosService = new SosService();
