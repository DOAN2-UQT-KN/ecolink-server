import type { Prisma, PrismaClient, ReportCategory } from "@prisma/client";
import prisma from "../../../config/prisma.client";
import { haversineKm } from "../../campaign/campaign-submit-validation";
import { geohashCellCenter, geohashEncode, normalizeVi } from "../../../utils/geo";
import type { FitRule } from "../verification-config.types";
import type { GeoEvidence } from "./category-fit";
import { goongClient, type GoongClient, type GoongPoint } from "./goong.client";

const DAY_MS = 86_400_000;
/** Half the diagonal of a 7-char geohash cell (~153 m x 153 m), so points near the edge miss nothing. */
const CELL7_HALF_DIAGONAL_M = 110;
const MAX_PLACE_DETAILS = 5;
const STREET_PREFIXES = ["duong ", "hem ", "ngo ", "kiet "];

interface CachedPlace {
  name: string;
  keyword: string;
  lat: number;
  lng: number;
}

export interface EvidenceResult {
  evidence: GeoEvidence[];
  goongCalls: number;
  cacheHit: boolean;
}

export interface GeoDeps {
  goong: GoongClient;
  db: Pick<PrismaClient, "geoContextCache">;
  now: () => Date;
  cacheTtlDays: number;
}

const defaultDeps = (cacheTtlDays: number): GeoDeps => ({ goong: goongClient, db: prisma, now: () => new Date(), cacheTtlDays });

const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  Math.round(haversineKm({ latitude: a.lat, longitude: a.lng }, { latitude: b.lat, longitude: b.lng }) * 1000);

async function cached(deps: GeoDeps, cellId: string, ruleKey: string) {
  const row = await deps.db.geoContextCache.findUnique({ where: { cellId_ruleKey: { cellId, ruleKey } } });
  return row && row.expiresAt > deps.now() ? row : null;
}

async function store(deps: GeoDeps, cellId: string, ruleKey: string, data: { places?: CachedPlace[]; address?: GoongPoint | null }) {
  const values = {
    places: (data.places ?? []) as unknown as Prisma.InputJsonValue,
    address: (data.address ?? undefined) as Prisma.InputJsonValue | undefined,
    fetchedAt: deps.now(),
    expiresAt: new Date(deps.now().getTime() + deps.cacheTtlDays * DAY_MS),
  };
  await deps.db.geoContextCache.upsert({
    where: { cellId_ruleKey: { cellId, ruleKey } },
    create: { cellId, ruleKey, ...values },
    update: values,
  });
}

/** Places matching the rule's keywords around the cell centre (cached per 7-char cell). */
async function nearbyPlaces(
  rule: Extract<FitRule, { kind: "NEARBY_PLACE" }>,
  ruleKey: string,
  lat: number,
  lng: number,
  signal: AbortSignal,
  deps: GeoDeps,
  calls: { n: number },
): Promise<CachedPlace[]> {
  const cellId = geohashEncode(lat, lng, 7);
  const hit = await cached(deps, cellId, ruleKey);
  if (hit) return hit.places as unknown as CachedPlace[];

  const center = geohashCellCenter(cellId);
  const radiusKm = Math.max(1, Math.ceil((rule.maxDistanceM + CELL7_HALF_DIAGONAL_M) / 1000));
  const candidates: { placeId: string; keyword: string }[] = [];
  for (const keyword of rule.keywords) {
    calls.n++;
    const predictions = await deps.goong.autocomplete({ input: keyword, lat: center.lat, lng: center.lng, radiusKm }, signal);
    const prefix = normalizeVi(keyword);
    for (const p of predictions) {
      const main = normalizeVi(p.mainText);
      // "Đường Kênh Tẻ" is a street, not a canal: keep only names starting with the keyword.
      if (main.startsWith(prefix) && !STREET_PREFIXES.some((s) => main.startsWith(s))) {
        candidates.push({ placeId: p.placeId, keyword });
      }
    }
  }

  const places: CachedPlace[] = [];
  for (const c of candidates.slice(0, MAX_PLACE_DETAILS)) {
    calls.n++;
    const point = await deps.goong.placeDetail(c.placeId, signal);
    if (point) places.push({ name: point.name, keyword: c.keyword, lat: point.lat, lng: point.lng });
  }
  await store(deps, cellId, ruleKey, { places });
  return places;
}

/** First Geocode result at the report's own point (cached per 8-char cell: street rules are metre-sensitive). */
async function addressAt(ruleKey: string, lat: number, lng: number, signal: AbortSignal, deps: GeoDeps, calls: { n: number }) {
  const cellId = geohashEncode(lat, lng, 8);
  const hit = await cached(deps, cellId, ruleKey);
  if (hit) return (hit.address as unknown as GoongPoint | null) ?? null;
  calls.n++;
  const address = await deps.goong.geocode(lat, lng, signal);
  await store(deps, cellId, ruleKey, { address });
  return address;
}

/**
 * Evidence for a category rule around a point, from Goong through a per-cell cache (specs/006 P08).
 * Distances are always measured from the report's point, never from the cell centre.
 */
export async function findEvidence(
  rule: FitRule,
  category: ReportCategory,
  rulesVersion: string,
  lat: number,
  lng: number,
  signal: AbortSignal,
  deps: GeoDeps = defaultDeps(30),
): Promise<EvidenceResult> {
  const ruleKey = `${category}@${rulesVersion}`;
  const calls = { n: 0 };
  const evidence: GeoEvidence[] = [];
  const here = { lat, lng };

  if (rule.kind === "NEARBY_PLACE") {
    for (const p of await nearbyPlaces(rule, ruleKey, lat, lng, signal, deps, calls)) {
      evidence.push({ name: p.name, keyword: p.keyword, distanceM: metres(here, p), source: "goong_place" });
    }
    if (rule.addressHints?.length) {
      const address = await addressAt(ruleKey, lat, lng, signal, deps, calls);
      const hint = address && rule.addressHints.find((h) => normalizeVi(address.name).includes(normalizeVi(h)));
      if (address && hint) evidence.push({ name: address.name, keyword: hint, distanceM: null, source: "goong_geocode" });
    }
  } else if (rule.kind === "ADDRESS_PATTERN" || rule.kind === "ON_STREET") {
    const address = await addressAt(ruleKey, lat, lng, signal, deps, calls);
    if (address) {
      evidence.push({ name: address.name, keyword: null, distanceM: metres(here, address), source: "goong_geocode" });
    }
  }

  return { evidence, goongCalls: calls.n, cacheHit: calls.n === 0 };
}

export { defaultDeps as geoDeps };
