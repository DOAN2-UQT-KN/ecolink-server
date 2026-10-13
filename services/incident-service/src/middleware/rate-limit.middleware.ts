import { Request, Response } from "express";
import rateLimit, { Options } from "express-rate-limit";
import { HTTP_STATUS, sendError } from "../constants/http-status";

/**
 * Fixed-window rate limiting for the public (unauthenticated) application endpoints.
 *
 * Every request reaches this service through the api-gateway, so `req.ip` is the gateway
 * for all callers and is useless as a key. The real client is the left-most hop of
 * `X-Forwarded-For`; we fall back to `req.ip` when the header is absent (direct calls in
 * tests / local dev).
 */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(",")[0]?.trim();
  return first || req.ip || null;
}

function clientIpKey(req: Request): string {
  return `ip:${(clientIp(req) ?? "unknown").toLowerCase()}`;
}

function tooManyRequests(message: string) {
  return (_req: Request, res: Response): void => {
    sendError(res, HTTP_STATUS.TOO_MANY_REQUESTS.withMessage(message));
  };
}

/**
 * Escape hatch for local work, where re-requesting a code every few seconds is normal and a
 * 3-per-hour budget just gets in the way.
 *
 * It takes **two** conditions on purpose: the flag alone does nothing in production. These
 * limits are the only thing stopping this service from being used to mail-bomb a stranger,
 * so a single stray env var in a deployed `.env` must not be able to switch them off.
 */
export function rateLimitDisabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.APPLICATION_RATE_LIMIT_DISABLED === "true";
}

let warnedOnce = false;

/** Says it out loud the first time, so nobody debugs a "missing" limit for an hour. */
function warnDisabledOnce(): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(
    "[rate-limit] APPLICATION_RATE_LIMIT_DISABLED=true and NODE_ENV is not production — " +
      "OTP and application rate limits are OFF for this process.",
  );
}

interface RateLimitSpec {
  windowMs: number;
  max: number;
  message: string;
  /** Defaults to the client IP; pass a custom key for per-email / per-resource limits. */
  keyGenerator?: (req: Request) => string;
  /**
   * Give the attempt back when the response is 4xx/5xx. Use it where the budget protects
   * something the request only consumes on success (a mailbox), not where it protects the
   * service itself from being hammered.
   */
  refundFailedRequests?: boolean;
}

export function createRateLimiter(spec: RateLimitSpec) {
  const options: Partial<Options> = {
    windowMs: spec.windowMs,
    limit: spec.max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: spec.keyGenerator ?? clientIpKey,
    handler: tooManyRequests(spec.message),
    skipFailedRequests: spec.refundFailedRequests ?? false,
    // Evaluated per request rather than at module load, so the flag is honoured even when
    // the limiters were built before dotenv finished.
    skip: () => {
      if (!rateLimitDisabled()) return false;
      warnDisabledOnce();
      return true;
    },
    // Our keys are already normalized above; skip the built-in IP/proxy validators so the
    // library does not warn about running behind the gateway.
    validate: { trustProxy: false, xForwardedForHeader: false },
  };
  return rateLimit(options);
}

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * 3 OTP requests per email per hour. This budget exists to stop one mailbox being spammed,
 * so only a code that actually went out should spend it — a mail outage must not lock the
 * applicant out of the form.
 */
export const otpPerEmailLimiter = createRateLimiter({
  windowMs: Number(process.env.OTP_RATE_WINDOW_MS ?? ONE_HOUR_MS),
  max: Number(process.env.OTP_RATE_MAX_PER_EMAIL ?? 3),
  message: "Too many verification codes requested for this email, try again later",
  keyGenerator: (req) =>
    `email:${String(req.body?.email ?? "").trim().toLowerCase()}`,
  refundFailedRequests: true,
});

/**
 * 10 OTP requests per client IP per hour. This one guards the service itself, so every
 * attempt counts — including the ones that fail.
 */
export const otpPerIpLimiter = createRateLimiter({
  windowMs: Number(process.env.OTP_RATE_WINDOW_MS ?? ONE_HOUR_MS),
  max: Number(process.env.OTP_RATE_MAX_PER_IP ?? 10),
  message: "Too many verification codes requested from this network, try again later",
});

/** Coarse guard on the remaining anonymous application endpoints. */
export const applicationPublicLimiter = createRateLimiter({
  windowMs: Number(process.env.APPLICATION_RATE_WINDOW_MS ?? ONE_HOUR_MS),
  max: Number(process.env.APPLICATION_RATE_MAX_PER_IP ?? 60),
  message: "Too many requests, try again later",
});
