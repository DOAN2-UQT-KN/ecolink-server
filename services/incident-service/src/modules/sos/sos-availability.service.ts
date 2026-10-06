import { Prisma } from "@prisma/client";
import { SOS_AVAILABILITY_ROUND_DEG } from "@da2/constants";
import prisma from "../../config/prisma.client";
import type { AvailabilityView, AvailabilityWindow } from "./sos.dto";

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Weekly windows of "Sẵn sàng"; null when malformed (days 0–6, "HH:mm", from before to). */
export function parseSchedule(raw: unknown): AvailabilityWindow[] | null {
  if (!Array.isArray(raw) || raw.length > 20) return null;
  const out: AvailabilityWindow[] = [];
  for (const w of raw as Array<Record<string, unknown>>) {
    if (!w || typeof w !== "object") return null;
    const days = w.days;
    if (
      !Array.isArray(days) ||
      days.length === 0 ||
      days.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)
    ) {
      return null;
    }
    if (typeof w.from !== "string" || typeof w.to !== "string") return null;
    if (!HH_MM.test(w.from) || !HH_MM.test(w.to) || w.from >= w.to) return null;
    out.push({ days: [...new Set(days as number[])].sort(), from: w.from, to: w.to });
  }
  return out;
}

/** About 500 m: the only location kept, overwritten each time, never shown. */
const roundCoord = (v: number) =>
  Math.round(v / SOS_AVAILABILITY_ROUND_DEG) * SOS_AVAILABILITY_ROUND_DEG;

const toView = (row: { enabled: boolean; schedule: unknown; locationUpdatedAt: Date | null } | null): AvailabilityView => ({
  enabled: row?.enabled ?? false,
  schedule: parseSchedule(row?.schedule) ?? [],
  locationUpdatedAt: row?.locationUpdatedAt ?? null,
});

/** A volunteer's "Sẵn sàng hỗ trợ SOS" (spec "Trạng thái Sẵn sàng của TNV"). */
export class SosAvailabilityService {
  async get(userId: string): Promise<AvailabilityView> {
    return toView(await prisma.volunteerAvailability.findUnique({ where: { userId } }));
  }

  async update(userId: string, input: { enabled: boolean; schedule: AvailabilityWindow[] }): Promise<AvailabilityView> {
    const schedule = input.schedule as unknown as Prisma.InputJsonValue;
    return toView(
      await prisma.volunteerAvailability.upsert({
        where: { userId },
        create: { userId, enabled: input.enabled, schedule },
        update: { enabled: input.enabled, schedule },
      }),
    );
  }

  async updateLocation(
    userId: string,
    at: { latitude: number; longitude: number },
    now = new Date(),
  ): Promise<AvailabilityView> {
    const data = { approxLat: roundCoord(at.latitude), approxLng: roundCoord(at.longitude), locationUpdatedAt: now };
    return toView(
      await prisma.volunteerAvailability.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      }),
    );
  }
}

export const sosAvailabilityService = new SosAvailabilityService();
