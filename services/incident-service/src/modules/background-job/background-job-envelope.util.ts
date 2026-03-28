/**
 * Minimal parse for routing and dead-letter handling without requiring a registered handler.
 */
export function parseBackgroundJobEnvelopeLoose(
  body: string,
): { jobId: string; jobType: string } | null {
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    if (typeof o.jobId !== "string" || !o.jobId) {
      return null;
    }
    if (typeof o.jobType !== "string" || !o.jobType) {
      return null;
    }
    return { jobId: o.jobId, jobType: o.jobType };
  } catch {
    return null;
  }
}
