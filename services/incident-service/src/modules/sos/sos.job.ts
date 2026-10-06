import {
  GlobalStatus,
  SOS_EXPAND_AFTER_MIN,
  SOS_HAZARD_ESCALATE_H,
  SOS_INVITE_RADIUS_EXPANDED_KM,
  SOS_LIVE_STATES,
  SOS_OWNER_ESCALATE_MIN,
  SOS_STATE,
  SOS_TYPE,
} from "@da2/constants";
import prisma from "../../config/prisma.client";
import { getCampaignAdminNotifyUserIds } from "../campaign/campaign-completion-admin-notify.config";
import {
  SOS_KIND,
  SOS_TIER,
  askNearbyOrganizations,
  closeResponders,
  inviteAvailableVolunteers,
  loadSosContext,
  manpowerCovered,
  ownerIds,
  sendSosNotice,
  teamAndOwnerIds,
} from "./sos-dispatch";

const MIN_MS = 60 * 1000;
const INTERVAL_MS = Number(process.env.SOS_JOB_INTERVAL_MS ?? 60 * 1000);

export interface SosSweepResult {
  ownersNotified: number;
  expanded: number;
  expired: number;
  escalated: number;
}

/**
 * One pass of the SOS job; each step takes its SOS with a compare-and-set update, so two workers
 * never send the same step twice:
 *   1. manpower / hazard still open (nobody coming) after 10 min: the owners hear
 *   2. manpower short of people after 15 min: radius 5 km, new "available" volunteers invited,
 *      then priority 2 (nearby organizations and admins)
 *   3. manpower past `expires_at`: expired; the people on the way hear
 *   4. hazard not resolved after 2 h: escalated to the admins
 */
export async function runSosSweep(now = new Date()): Promise<SosSweepResult> {
  const result: SosSweepResult = { ownersNotified: 0, expanded: 0, expired: 0, escalated: 0 };

  const toOwners = await prisma.sos.findMany({
    where: {
      deletedAt: null,
      type: { in: [SOS_TYPE.MANPOWER, SOS_TYPE.HAZARD] },
      state: SOS_STATE.OPEN,
      ownerNotifiedAt: null,
      createdAt: { lte: new Date(now.getTime() - SOS_OWNER_ESCALATE_MIN * MIN_MS) },
    },
    select: { id: true },
  });
  for (const { id } of toOwners) {
    await prisma.$transaction(async (tx) => {
      const won = await tx.sos.updateMany({
        where: { id, state: SOS_STATE.OPEN, ownerNotifiedAt: null },
        data: { ownerNotifiedAt: now },
      });
      if (won.count === 0) return;
      const sos = await tx.sos.findUniqueOrThrow({ where: { id } });
      const ctx = await loadSosContext(tx, sos);
      await sendSosNotice(tx, sos, ctx, {
        kind: SOS_KIND.OWNER_ESCALATION,
        userIds: (await ownerIds(ctx)).filter((u) => u !== sos.createdBy),
        tier: SOS_TIER.TEAM,
        dedupKey: `${SOS_KIND.OWNER_ESCALATION}:${id}`,
      });
      result.ownersNotified++;
    });
  }

  const toExpand = await prisma.sos.findMany({
    where: {
      deletedAt: null,
      type: SOS_TYPE.MANPOWER,
      state: { in: [SOS_STATE.OPEN, SOS_STATE.HELPING] },
      tier2SentAt: null,
      createdAt: { lte: new Date(now.getTime() - SOS_EXPAND_AFTER_MIN * MIN_MS) },
    },
  });
  for (const candidate of toExpand) {
    await prisma.$transaction(async (tx) => {
      if (await manpowerCovered(tx, candidate)) return;
      const won = await tx.sos.updateMany({
        where: { id: candidate.id, tier2SentAt: null, state: { in: [SOS_STATE.OPEN, SOS_STATE.HELPING] } },
        data: { tier2SentAt: now, radiusKm: SOS_INVITE_RADIUS_EXPANDED_KM },
      });
      if (won.count === 0) return;
      const sos = await tx.sos.findUniqueOrThrow({ where: { id: candidate.id } });
      const ctx = await loadSosContext(tx, sos);
      await inviteAvailableVolunteers(tx, sos, ctx, await teamAndOwnerIds(tx, sos, ctx), now);
      await askNearbyOrganizations(tx, sos, ctx);
      result.expanded++;
    });
  }

  const toExpire = await prisma.sos.findMany({
    where: {
      deletedAt: null,
      type: SOS_TYPE.MANPOWER,
      state: { in: [SOS_STATE.OPEN, SOS_STATE.HELPING] },
      expiresAt: { lte: now },
    },
    select: { id: true },
  });
  for (const { id } of toExpire) {
    await prisma.$transaction(async (tx) => {
      const won = await tx.sos.updateMany({
        where: { id, state: { in: [SOS_STATE.OPEN, SOS_STATE.HELPING] } },
        data: { state: SOS_STATE.EXPIRED, status: GlobalStatus._STATUS_COMPLETED },
      });
      if (won.count === 0) return;
      const sos = await tx.sos.findUniqueOrThrow({ where: { id } });
      await closeResponders(tx, sos, await loadSosContext(tx, sos), SOS_KIND.EXPIRED, now);
      result.expired++;
    });
  }

  const toEscalate = await prisma.sos.findMany({
    where: {
      deletedAt: null,
      type: SOS_TYPE.HAZARD,
      state: { in: SOS_LIVE_STATES.filter((s) => s !== SOS_STATE.ESCALATED) },
      escalatedAt: null,
      createdAt: { lte: new Date(now.getTime() - SOS_HAZARD_ESCALATE_H * 60 * MIN_MS) },
    },
    select: { id: true },
  });
  for (const { id } of toEscalate) {
    await prisma.$transaction(async (tx) => {
      const won = await tx.sos.updateMany({
        where: { id, escalatedAt: null, state: { in: [SOS_STATE.OPEN, SOS_STATE.HELPING] } },
        data: { state: SOS_STATE.ESCALATED, escalatedAt: now },
      });
      if (won.count === 0) return;
      const sos = await tx.sos.findUniqueOrThrow({ where: { id } });
      await sendSosNotice(tx, sos, await loadSosContext(tx, sos), {
        kind: SOS_KIND.ESCALATED,
        userIds: getCampaignAdminNotifyUserIds(),
        tier: SOS_TIER.ADMIN,
        dedupKey: `${SOS_KIND.ESCALATED}:${id}`,
      });
      result.escalated++;
    });
  }

  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const r = await runSosSweep();
    if (r.ownersNotified + r.expanded + r.expired + r.escalated > 0) {
      console.log(
        `[SosJob] ${r.ownersNotified} owner escalation(s), ${r.expanded} widened, ${r.expired} expired, ${r.escalated} sent to admins`,
      );
    }
  } catch (error) {
    console.error("[SosJob] sweep failed", error);
  } finally {
    running = false;
  }
}

/** Every minute by default (`SOS_JOB_INTERVAL_MS`); `SOS_JOB_ENABLED=false` turns it off. */
export function startSosJob(): void {
  if (process.env.SOS_JOB_ENABLED === "false") {
    console.log("[SosJob] disabled via SOS_JOB_ENABLED=false");
    return;
  }
  if (timer) return;
  void tick();
  timer = setInterval(() => void tick(), INTERVAL_MS);
}

export function stopSosJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
