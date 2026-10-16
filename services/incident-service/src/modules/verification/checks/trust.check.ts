// Reads only server-side data; client EXIF / GPS / capture time are never scored (specs/006 FR-025).
import prisma from "../../../config/prisma.client";
import { REPORT_STATUS_REJECTED } from "../../../constants/report-verification";
import { fetchUserVoteProfile } from "../../organization/identity-user.client";
import type { CheckRunner } from "./check-runner";
import { scoreTrust, type TrustInput } from "./trust-score";

const DAY_MS = 86_400_000;

export const trustCheck: CheckRunner = {
  name: "TRUST",
  signalNames: ["capture", "reject_history", "account_age"],
  version: (cfg) => cfg.trust.version,
  async run(ctx) {
    const cfg = ctx.checksConfig.trust;
    const now = Date.now();
    const live = ctx.media.filter((m) => m.captureSource === "LIVE").length;
    const images = ctx.media.length > 0 ? { live, gallery: ctx.media.length - live } : null;

    let history: TrustInput["history"] = null;
    let accountAgeDays: TrustInput["accountAgeDays"] = null;
    const userId = ctx.report.userId;
    if (userId) {
      // Soft-deleted reports count too: deleting a rejected report must not clean the record.
      const where = {
        userId,
        id: { not: ctx.report.id },
        createdAt: { gte: new Date(now - cfg.rejectWindowDays * DAY_MS) },
      };
      const [total, rejected, profile] = await Promise.all([
        prisma.report.count({ where }),
        prisma.report.count({ where: { ...where, status: REPORT_STATUS_REJECTED } }),
        fetchUserVoteProfile({
          userId,
          latitude: ctx.report.latitude ?? 0,
          longitude: ctx.report.longitude ?? 0,
        }),
      ]);
      history = { total, rejected };
      accountAgeDays = profile ? Math.floor((now - profile.createdAt.getTime()) / DAY_MS) : "FAILED";
    }

    return {
      check: "TRUST",
      version: cfg.version,
      durationMs: 0,
      ...scoreTrust({ images, history, accountAgeDays }, cfg),
    };
  },
};
