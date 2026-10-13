import {
  CAMPAIGN_ATTENDANCE_MAX_ACCURACY_M,
  CAMPAIGN_COMPLETION_MAX_REJECTIONS,
  RESULT_CHECK_LEVEL,
  MEETING_POINT_DECISION,
  MEETING_POINT_FLAG_SCORE,
  MEETING_POINT_STATUS,
  MEETING_POINT_VERIFIED_SCORE,
  MEETING_POINT_VOTE_MIN_ACCOUNT_DAYS,
  MEETING_POINT_VOTE_NEARBY_M,
  MEETING_POINT_VOTE_ON_SITE_M,
  MEETING_POINT_VOTE_WEIGHT,
  MEETING_POINT_WEIGHT_REASON,
  type ResultCheckLevelValue,
  type MeetingPointDecisionValue,
  type MeetingPointStatusValue,
  type MeetingPointWeightReasonValue,
} from "@da2/constants";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface VoteWeight {
  weight: number;
  reason: MeetingPointWeightReasonValue;
}

/**
 * Layer 2 / 3: what a vote on a meeting point weighs, the highest level the voter qualifies for.
 * An original reporter of one of its trash points 10, wherever they are (once, however many they
 * reported); live GPS within 30 m of the meeting point or one of its trash points (accuracy no
 * worse than attendance accepts) 3; live GPS or the saved location within 5 km 1; anyone else 0.
 * An account younger than 7 days, or without a verified email, always weighs 0 (shown to the admin).
 */
export function voteWeight(input: {
  isReporter: boolean;
  /** Live GPS distance to the nearest of the meeting point and its trash points; null without GPS. */
  gpsDistanceM: number | null;
  gpsAccuracyM: number | null;
  savedLocationDistanceM: number | null;
  accountCreatedAt: Date;
  emailVerified: boolean;
  now: Date;
}): VoteWeight {
  if (input.now.getTime() - input.accountCreatedAt.getTime() < MEETING_POINT_VOTE_MIN_ACCOUNT_DAYS * DAY_MS) {
    return { weight: 0, reason: MEETING_POINT_WEIGHT_REASON.ZERO_NEW_ACCOUNT };
  }
  if (!input.emailVerified) return { weight: 0, reason: MEETING_POINT_WEIGHT_REASON.ZERO_UNVERIFIED };
  if (input.isReporter) return { weight: MEETING_POINT_VOTE_WEIGHT.REPORTER, reason: MEETING_POINT_WEIGHT_REASON.REPORTER };
  const preciseEnough = input.gpsAccuracyM == null || input.gpsAccuracyM <= CAMPAIGN_ATTENDANCE_MAX_ACCURACY_M;
  if (input.gpsDistanceM != null && preciseEnough && input.gpsDistanceM <= MEETING_POINT_VOTE_ON_SITE_M) {
    return { weight: MEETING_POINT_VOTE_WEIGHT.ON_SITE, reason: MEETING_POINT_WEIGHT_REASON.ON_SITE };
  }
  const near = (d: number | null) => d != null && d <= MEETING_POINT_VOTE_NEARBY_M;
  if (near(input.gpsDistanceM) || near(input.savedLocationDistanceM)) {
    return { weight: MEETING_POINT_VOTE_WEIGHT.NEARBY, reason: MEETING_POINT_WEIGHT_REASON.NEARBY };
  }
  return { weight: 0, reason: MEETING_POINT_WEIGHT_REASON.ZERO_FAR };
}

type LatLng = { latitude: number; longitude: number };

/**
 * Distance in metres from `from` to the nearest of `places` (the meeting point and its trash
 * points); null when there is no place. `distanceKm` is the haversine of the caller.
 */
export function nearestDistanceM(
  from: LatLng,
  places: Array<LatLng | null | undefined>,
  distanceKm: (a: LatLng, b: LatLng) => number,
): number | null {
  let best: number | null = null;
  for (const p of places) {
    if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    const m = Math.round(distanceKm(from, p) * 1000);
    if (best == null || m < best) best = m;
  }
  return best;
}

/**
 * One trash point of a meeting point's round (`MeetingPointVerification.layer1`): its Layer 1 when
 * the round opened, with the photos it was graded on.
 */
export interface MeetingPointLayer1Entry {
  reportId: string;
  level: ResultCheckLevelValue;
  issues: Array<{ code: string; side?: string; url?: string }>;
  beforeUrls: string[];
  afterUrls: string[];
}

const LEVEL_RANK: Record<ResultCheckLevelValue, number> = { pass: 0, warn: 1, fail: 2 };

/** Layer 1 of a meeting point: the worst of its cleaned trash points (pass when there is none). */
export function meetingPointLayer1Level(levels: ResultCheckLevelValue[]): ResultCheckLevelValue {
  return levels.reduce<ResultCheckLevelValue>(
    (worst, l) => (LEVEL_RANK[l] > LEVEL_RANK[worst] ? l : worst),
    RESULT_CHECK_LEVEL.PASS,
  );
}

/**
 * The trash points of a rejected meeting point that did not pass (their shifts reopen), when the
 * system rejected it: Layer 1 failed, the ones Layer 1 failed; a flag left past the admin's
 * deadline, the ones weighted downvotes pointed at. Fallback (and any other cause): every trash
 * point of the round. The admin names them when they reject (not computed here).
 */
export function failedReportsOf(
  round: { reportIds: string[]; layer1: Array<{ reportId: string; level: string }> },
  votes: Array<{ value: number; weight: number; flaggedReportIds: string[] }>,
  cause: MeetingPointDecisionValue | null,
): string[] {
  const inRound = new Set(round.reportIds);
  let failed: string[] = [];
  if (cause === MEETING_POINT_DECISION.LAYER1_FAIL) {
    failed = round.layer1.filter((l) => l.level === RESULT_CHECK_LEVEL.FAIL).map((l) => l.reportId);
  } else if (cause === MEETING_POINT_DECISION.FLAG_TIMEOUT) {
    failed = votes.filter((v) => v.value < 0 && v.weight > 0).flatMap((v) => v.flaggedReportIds);
  }
  const out = round.reportIds.filter((id) => failed.includes(id) && inRound.has(id));
  return out.length > 0 ? out : [...round.reportIds];
}

/** Score = upvote weights − downvote weights; "has a downvote" counts only votes that weigh. */
export function tally(votes: Array<{ value: number; weight: number }>): { score: number; hasDownvote: boolean } {
  return {
    score: votes.reduce((sum, v) => sum + v.value * v.weight, 0),
    hasDownvote: votes.some((v) => v.value < 0 && v.weight > 0),
  };
}

export interface PointTransition {
  status: MeetingPointStatusValue;
  code: MeetingPointDecisionValue | null;
}

/**
 * After a vote on a meeting point, while the window is open: ≥ 15 verified at once (a flagged one
 * too); one still voting with a downvote and ≤ 3 is flagged for the admin. Otherwise unchanged.
 */
export function pointAfterVote(input: {
  status: MeetingPointStatusValue;
  score: number;
  hasDownvote: boolean;
}): PointTransition | null {
  if (input.status !== MEETING_POINT_STATUS.VOTING && input.status !== MEETING_POINT_STATUS.FLAGGED) return null;
  if (input.score >= MEETING_POINT_VERIFIED_SCORE) {
    return { status: MEETING_POINT_STATUS.VERIFIED, code: MEETING_POINT_DECISION.SCORE };
  }
  if (input.status === MEETING_POINT_STATUS.VOTING && input.hasDownvote && input.score <= MEETING_POINT_FLAG_SCORE) {
    return { status: MEETING_POINT_STATUS.FLAGGED, code: null };
  }
  return null;
}

/**
 * The window closed on a meeting point still voting: with a downvote, flagged; without, Layer 1 decides
 * (pass verified, warning flagged, fail rejected).
 */
export function pointAtWindowEnd(input: {
  hasDownvote: boolean;
  layer1Level: ResultCheckLevelValue;
}): PointTransition {
  if (input.hasDownvote) return { status: MEETING_POINT_STATUS.FLAGGED, code: null };
  if (input.layer1Level === RESULT_CHECK_LEVEL.PASS) {
    return { status: MEETING_POINT_STATUS.VERIFIED, code: MEETING_POINT_DECISION.LAYER1_PASS };
  }
  if (input.layer1Level === RESULT_CHECK_LEVEL.FAIL) {
    return { status: MEETING_POINT_STATUS.REJECTED, code: MEETING_POINT_DECISION.LAYER1_FAIL };
  }
  return { status: MEETING_POINT_STATUS.FLAGGED, code: null };
}

export type CampaignDecision = "complete" | "reject" | "await_admin" | "wait";

/**
 * The campaign from its meeting points' latest rounds: all verified, completed; something rejected
 * and nothing left to decide, rejected (back to running) unless it already was 3 times, then the
 * admin decides; anything still voting or flagged, wait. No point at all: wait (the admin was
 * already handed the campaign when it was marked done).
 */
export function campaignDecision(statuses: string[], rejectionCount: number): CampaignDecision {
  if (statuses.length === 0) return "wait";
  if (statuses.some((s) => s === MEETING_POINT_STATUS.VOTING || s === MEETING_POINT_STATUS.FLAGGED)) return "wait";
  if (statuses.every((s) => s === MEETING_POINT_STATUS.VERIFIED)) return "complete";
  return rejectionCount < CAMPAIGN_COMPLETION_MAX_REJECTIONS ? "reject" : "await_admin";
}

/** Reasons the system writes on a meeting point it rejects (the client can localize `decision_code`). */
export const SYSTEM_REJECT_REASON: Partial<Record<MeetingPointDecisionValue, string>> = {
  [MEETING_POINT_DECISION.LAYER1_FAIL]: "Ảnh không đạt kiểm tra tự động (Layer 1)",
  [MEETING_POINT_DECISION.FLAG_TIMEOUT]: "Admin không xử lý kịp trong 48 giờ",
};
