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

/** The draft editor; the token is the only credential, so this link must stay private. */
export function buildApplicationEditUrl(
  applicationId: string,
  token: string,
): string {
  return `${frontendBaseUrl()}/organizations/apply/edit/${applicationId}?token=${encodeURIComponent(token)}`;
}

/** Where a newly created owner account sets its first password. */
export function buildAccountActivationUrl(token: string): string {
  return `${frontendBaseUrl()}/activate-account?token=${encodeURIComponent(token)}`;
}

/** Public page where an owner candidate confirms or declines. No login needed. */
export function buildOwnerConfirmUrl(token: string): string {
  return `${frontendBaseUrl()}/organizations/owner-confirm?token=${encodeURIComponent(token)}`;
}

/** Where an owner lands to manage the organization. */
export function buildOrganizationManageUrl(slug: string): string {
  return `${frontendBaseUrl()}/organizations/${encodeURIComponent(slug)}`;
}

/** Reopens the form on the code step, with the address from the mail already locked in. */
export function buildApplicationResumeUrl(token: string): string {
  return `${frontendBaseUrl()}/organizations/apply?t=${encodeURIComponent(token)}`;
}
