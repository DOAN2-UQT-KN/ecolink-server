import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma.client";

export type RiskVerdict = "yes" | "no";

/** Identity of a flagged site: its coordinates to 5 decimals, so the map and the DB agree. */
export function riskSiteKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)}:${lng.toFixed(5)}`;
}

export const riskSiteService = {
  /** Records (or changes) one user's answer for one site. */
  async vote(input: {
    userId: string;
    lat: number;
    lng: number;
    address: string;
    verdict: RiskVerdict;
  }) {
    const siteKey = riskSiteKey(input.lat, input.lng);
    const row = await prisma.riskSiteVote.upsert({
      where: { siteKey_userId: { siteKey, userId: input.userId } },
      create: {
        siteKey,
        address: input.address,
        latitude: input.lat,
        longitude: input.lng,
        userId: input.userId,
        verdict: input.verdict,
      },
      update: { verdict: input.verdict, address: input.address },
    });
    return { siteKey: row.siteKey, verdict: row.verdict };
  },

  /** Per site: how many distinct people said "trash" and how many said "none". */
  async listForAdmin(input: { page: number; limit: number }) {
    const offset = (input.page - 1) * input.limit;
    const rows = await prisma.$queryRaw<
      {
        site_key: string;
        address: string;
        latitude: number;
        longitude: number;
        yes_count: number;
        no_count: number;
        last_voted_at: Date;
      }[]
    >(Prisma.sql`
      SELECT site_key,
             (array_agg(address ORDER BY updated_at DESC))[1] AS address,
             min(latitude)  AS latitude,
             min(longitude) AS longitude,
             (count(*) FILTER (WHERE verdict = 'yes'))::int AS yes_count,
             (count(*) FILTER (WHERE verdict = 'no'))::int  AS no_count,
             max(updated_at) AS last_voted_at
      FROM risk_site_votes
      GROUP BY site_key
      ORDER BY count(*) DESC, max(updated_at) DESC
      LIMIT ${input.limit} OFFSET ${offset}
    `);
    const [{ total }] = await prisma.$queryRaw<{ total: number }[]>(
      Prisma.sql`SELECT count(DISTINCT site_key)::int AS total FROM risk_site_votes`,
    );
    return {
      items: rows.map((r) => ({
        siteKey: r.site_key,
        address: r.address,
        latitude: r.latitude,
        longitude: r.longitude,
        yesCount: r.yes_count,
        noCount: r.no_count,
        lastVotedAt: r.last_voted_at,
      })),
      total,
      page: input.page,
      limit: input.limit,
      totalPages: Math.ceil(total / input.limit),
    };
  },
};
