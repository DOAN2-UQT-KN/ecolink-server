/**
 * Fixed rules checked synchronously on POST /reports (specs/006 P02): they always give the
 * same answer, so the user gets an error right away instead of a report rejected later.
 */
import type { Prisma, PrismaClient, Report } from "@prisma/client";
import { HttpError, HTTP_STATUS } from "../../constants/http-status";

type Db = PrismaClient | Prisma.TransactionClient;

export const REPORT_RATE_LIMIT = { max: 5, windowMs: 24 * 60 * 60 * 1000 } as const;

/**
 * shortcut: temporarily raised via REPORT_RATE_LIMIT_MAX for testing; drop the env and keep 5 when done.
 * Read per call so the value does not depend on when dotenv runs.
 */
function rateLimitMax(): number {
  const fromEnv = Number(process.env.REPORT_RATE_LIMIT_MAX);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : REPORT_RATE_LIMIT.max;
}

/** BR-113: the point must lie in an active service area. No active area = no check (fail-open). */
export async function assertInServiceArea(db: Db, lat: number, lng: number): Promise<void> {
  if (process.env.SERVICE_AREA_CHECK_DISABLED === "true") return;

  const [row] = await db.$queryRaw<{ inside: bigint; total: bigint }[]>`
    SELECT count(*) FILTER (
             WHERE ST_Covers(geog, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography)
           ) AS inside,
           count(*) AS total
    FROM service_areas WHERE active`;

  if (Number(row?.total ?? 0) === 0) {
    console.warn("[report] no active service area; skipping check");
    return;
  }
  if (Number(row.inside) === 0) throw new HttpError(HTTP_STATUS.REPORT_OUT_OF_SERVICE_AREA);
}

/** Serialises every submit of one user inside the current transaction (released on commit). */
export async function lockUserForSubmit(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
}

/**
 * BR-114: at most 5 reports (REPORT_RATE_LIMIT_MAX) per sliding 24 h window. Soft-deleted reports count too,
 * so deleting and re-sending does not reset the limit.
 */
export async function assertUnderRateLimit(tx: Db, userId: string, now: Date): Promise<void> {
  const max = rateLimitMax();
  const recent = await tx.report.findMany({
    where: { userId, createdAt: { gt: new Date(now.getTime() - REPORT_RATE_LIMIT.windowMs) } },
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
    take: max,
  });
  if (recent.length < max) return;

  const retryAfter = new Date(recent[0].createdAt.getTime() + REPORT_RATE_LIMIT.windowMs);
  throw new HttpError(HTTP_STATUS.REPORT_RATE_LIMITED, { retryAfter: retryAfter.toISOString() });
}

/** BR-115: a retried submit (same user + Idempotency-Key) returns the first report, even if deleted. */
export function findByIdempotencyKey(db: Db, userId: string, key: string): Promise<Report | null> {
  return db.report.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } });
}
