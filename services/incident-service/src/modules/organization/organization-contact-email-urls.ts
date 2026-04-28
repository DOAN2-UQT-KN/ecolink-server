/** Base URL of this incident-service as reachable by the contact's mail client (no trailing slash). */
export function publicIncidentApiBaseUrl(): string {
  const port = process.env.PORT || "3001";
  const base =
    process.env.PUBLIC_INCIDENT_API_URL?.trim() ||
    `http://localhost:${port}`;
  return base.replace(/\/$/, "");
}

export function buildVerifyContactEmailRequestUrl(token: string): string {
  return `${publicIncidentApiBaseUrl()}/api/v1/organizations/verify-contact-email?token=${encodeURIComponent(token)}`;
}

export function frontendBaseUrl(): string {
  return (process.env.FRONTEND_APP_URL?.trim() || "http://localhost:3000").replace(
    /\/$/,
    "",
  );
}

export function redirectAfterContactEmailVerified(organizationId: string): string {
  // Redirect straight to org detail so the UI can show toast and updated badge.
  return `${frontendBaseUrl()}/organizations/${organizationId}?verifiedEmail=1`;
}

export function redirectAfterContactEmailVerifyFailed(
  reason: "invalid_or_expired" | "mismatch" | "not_found",
): string {
  return `${frontendBaseUrl()}/organizations/email-verified?error=${reason}`;
}
