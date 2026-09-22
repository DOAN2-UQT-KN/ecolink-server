/** Frontend base URL used in emails (no trailing slash). */
export function frontendBaseUrl(): string {
  return (
    process.env.FRONTEND_APP_URL?.trim() || "http://localhost:3000"
  ).replace(/\/$/, "");
}

/** Where the applicant follows their submission. The token proves they own the mailbox. */
export function buildApplicationTrackUrl(
  applicationId: string,
  token: string,
): string {
  return `${frontendBaseUrl()}/organizations/apply/status/${applicationId}?token=${encodeURIComponent(token)}`;
}

/** Where the organization sets the first password of its provisioned ORG account. */
export function buildOrgAccountActivationUrl(token: string): string {
  return `${frontendBaseUrl()}/activate-organization?token=${encodeURIComponent(token)}`;
}
