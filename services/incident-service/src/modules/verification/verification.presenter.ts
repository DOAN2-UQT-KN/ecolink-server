import type { ModerationReasonCode } from "@prisma/client";
import {
  isAdminOnlyReason,
  REPORT_STATUS_ACCEPTED,
  REPORT_STATUS_REJECTED,
} from "../../constants/report-verification";
import type { VerificationWithChecks } from "./verification-query.service";

type Check = VerificationWithChecks["checks"][number];

export interface UserIssue {
  code: string;
  primary: boolean;
  evidence: Record<string, unknown>;
}

/** Which pipeline reason a moderator's rejection reason points to; null = none (synthetic MOD_* issue). */
const PRIMARY_REASON_BY_MODERATION: Record<ModerationReasonCode, (code: string) => boolean> = {
  DUPLICATE_OF_OTHER: (code) => code.startsWith("DUP_"),
  NOT_ON_SITE: (code) => code === "TRUST_NOT_LIVE_CAPTURE",
  INAPPROPRIATE_CONTENT: () => false,
};

function evidenceOf(checks: Check[], name: Check["check"]): Record<string, unknown> {
  const evidence = checks.find((c) => c.check === name)?.evidence;
  return evidence && typeof evidence === "object" && !Array.isArray(evidence) ? (evidence as Record<string, unknown>) : {};
}

/** Minimal evidence an owner may see: never another user's identity, never a score. */
function ownerEvidence(code: string, checks: Check[]): Record<string, unknown> {
  // A web match: the public page the photo was found on, no scores (specs/011 FR-023, revised).
  if (code === "DUP_WEB_IMAGE_MATCH") {
    const match = evidenceOf(checks, "DUPLICATE").match as Record<string, unknown> | null | undefined;
    const https = (v: unknown) => (typeof v === "string" && v.startsWith("https://") ? v : null);
    if (!match || match.method !== "internet" || !https(match.source_url)) return {};
    return {
      image_index: typeof match.image_index === "number" ? match.image_index : null,
      source_url: https(match.source_url),
      page_url: https(match.page_url),
      page_title: typeof match.page_title === "string" ? match.page_title : null,
    };
  }
  if (code.startsWith("DUP_")) {
    const match = evidenceOf(checks, "DUPLICATE").match as Record<string, unknown> | null | undefined;
    if (!match) return {};
    return {
      similar_report_id: match.report_id ?? null,
      distance_m: match.distance_m ?? null,
      time_delta_hours: match.time_delta_hours ?? null,
    };
  }
  if (code === "CTX_CATEGORY_LOCATION_MISMATCH") {
    const evidence = evidenceOf(checks, "CONTEXT");
    const nearest = evidence.nearest as Record<string, unknown> | null | undefined;
    // Categories that would fit here (specs/012): label, place name and distance only.
    const suggested = Array.isArray(evidence.suggestedCategories) ? (evidence.suggestedCategories as Record<string, unknown>[]) : [];
    return {
      nearest: nearest ? { name: nearest.name ?? null, distance_m: nearest.distance_m ?? null } : null,
      suggested_categories: suggested.map((c) => {
        const n = c.nearest as Record<string, unknown> | null | undefined;
        return { category: c.category, nearest: n ? { name: n.name ?? null, distance_m: n.distance_m ?? null } : null };
      }),
    };
  }
  return {};
}

/** Owner view (specs/006 FR-040/041): public reasons only, ordered as the engine ranked them. */
export function toUserView(
  v: VerificationWithChecks,
  report: { id: string; status: number | null; moderationReasonCode: ModerationReasonCode | null },
) {
  const completed = v.status === "COMPLETED";
  let issues: UserIssue[] = completed
    ? v.reasons
        .filter((code) => !isAdminOnlyReason(code))
        .map((code) => ({ code, primary: false, evidence: ownerEvidence(code, v.checks) }))
    : [];

  const reasonCode = report.moderationReasonCode;
  if (report.status === REPORT_STATUS_REJECTED && reasonCode) {
    const index = issues.findIndex((i) => PRIMARY_REASON_BY_MODERATION[reasonCode](i.code));
    const primary =
      index >= 0 ? { ...issues[index], primary: true } : { code: `MOD_${reasonCode}`, primary: true, evidence: {} };
    issues = [primary, ...issues.filter((_, i) => i !== index)];
  }

  return {
    reportId: report.id,
    reportStatus: report.status,
    attempt: v.attempt,
    status: v.status,
    flag: completed ? v.flag : null,
    issues,
    completedAt: v.completedAt,
  };
}

/** Admin view: every reason, score, signal and evidence of each check. */
export function toAdminView(
  v: VerificationWithChecks,
  report: {
    id: string;
    status: number | null;
    moderatedBy: string | null;
    moderatedAt: Date | null;
    moderationReasonCode: ModerationReasonCode | null;
  },
) {
  const checks = Object.fromEntries(
    v.checks.map((c) => [
      c.check,
      {
        status: c.status,
        risk: c.risk,
        reasons: c.reasons,
        signals: c.signals,
        evidence: c.evidence,
        durationMs: c.durationMs,
        version: c.version,
        error: c.error,
      },
    ]),
  );
  return {
    reportId: report.id,
    reportStatus: report.status,
    verificationId: v.id,
    attempt: v.attempt,
    status: v.status,
    riskScore: v.riskScore,
    flag: v.flag,
    reasons: v.reasons,
    checks,
    versions: { pipeline: v.pipelineVersion, engine: v.engineVersion },
    moderation: report.moderatedAt
      ? {
          decision:
            report.status === REPORT_STATUS_ACCEPTED ? "ACCEPT" : report.status === REPORT_STATUS_REJECTED ? "REJECT" : null,
          reasonCode: report.moderationReasonCode,
          by: report.moderatedBy,
          at: report.moderatedAt,
        }
      : null,
    startedAt: v.startedAt,
    completedAt: v.completedAt,
  };
}
