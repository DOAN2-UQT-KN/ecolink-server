import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import {
  MAX_OWNERS_PER_APPLICATION,
  OWNER_CONFIRM_RESEND_COOLDOWN_MS,
  OWNER_CONFIRM_TTL_DAYS,
  OwnerCandidateStatus,
} from "@da2/constants";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { generateOpaqueToken, hashOpaqueToken } from "../../utils/token-hash";
import {
  OwnerCandidateInput,
  OwnerCandidateResponse,
} from "./organization-application.dto";
import { enqueueOwnerConfirmationRequestEmail } from "./organization-application-notify.client";
import { buildOwnerConfirmUrl } from "./organization-application-urls";

export type CandidateRow = Prisma.OrganizationApplicationOwnerGetPayload<object>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Shape checks that are cheap and never depend on other data, run on every draft save so the
 * form cannot store garbage: valid emails, names present, no duplicates, at most 5 rows.
 */
export function normalizeOwnerInputs(
  owners: OwnerCandidateInput[],
): OwnerCandidateInput[] {
  if (owners.length > MAX_OWNERS_PER_APPLICATION) {
    throw new HttpError(
      HTTP_STATUS.TOO_MANY_OWNERS.withMessage(
        `At most ${MAX_OWNERS_PER_APPLICATION} owners per application`,
      ),
    );
  }
  const normalized = owners.map((owner) => {
    const email = normalizeEmail(owner.email ?? "");
    const fullName = owner.fullName?.trim() ?? "";
    if (!EMAIL_PATTERN.test(email) || email.length > 320) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(`Invalid owner email: ${owner.email}`),
      );
    }
    if (!fullName || fullName.length > 200) {
      throw new HttpError(
        HTTP_STATUS.INVALID_INPUT.withMessage(`Owner ${email} needs a full name`),
      );
    }
    return {
      email,
      fullName,
      isLegalRep: Boolean(owner.isLegalRep),
      nationalIdDocumentId: owner.nationalIdDocumentId ?? null,
    };
  });
  const emails = normalized.map((o) => o.email);
  if (new Set(emails).size !== emails.length) {
    throw new HttpError(HTTP_STATUS.DUPLICATE_OWNER_EMAIL);
  }
  return normalized;
}

/**
 * The rules an owner list must satisfy before it can be submitted.
 *
 * `SUBMITTER_MUST_BE_OWNER`: the submitter's mailbox already passed the OTP, so their
 * confirmation can be recorded automatically, and it guarantees that at least one person is
 * accountable from the start — nobody can found an organization and hand the power to
 * others while taking no responsibility themselves.
 */
export function validateOwnerList(
  owners: { email: string; isLegalRep: boolean }[],
  submitterEmail: string,
): void {
  if (owners.length === 0) throw new HttpError(HTTP_STATUS.AT_LEAST_ONE_OWNER);
  if (owners.length > MAX_OWNERS_PER_APPLICATION) {
    throw new HttpError(HTTP_STATUS.TOO_MANY_OWNERS);
  }

  const emails = owners.map((o) => normalizeEmail(o.email));
  if (new Set(emails).size !== emails.length) {
    throw new HttpError(HTTP_STATUS.DUPLICATE_OWNER_EMAIL);
  }
  if (!emails.includes(normalizeEmail(submitterEmail))) {
    throw new HttpError(HTTP_STATUS.SUBMITTER_MUST_BE_OWNER);
  }
  if (owners.filter((o) => o.isLegalRep).length !== 1) {
    throw new HttpError(HTTP_STATUS.EXACTLY_ONE_LEGAL_REP);
  }
}

/**
 * What the owners agree to. Changing any of these after someone confirmed would let a
 * submitter collect signatures for a harmless application and then turn it into something
 * else, so a change resets every confirmation. Description, logo, documents and channels are
 * deliberately left out: editing them keeps the confirmations.
 */
export function buildConfirmationSnapshot(input: {
  name: string | null | undefined;
  orgType: string | null | undefined;
  owners: { email: string; isLegalRep: boolean }[];
}): Record<string, unknown> {
  return {
    name: input.name?.trim() ?? null,
    orgType: input.orgType ?? null,
    legalRepEmail:
      input.owners.find((o) => o.isLegalRep)?.email.toLowerCase() ?? null,
    ownerEmails: input.owners.map((o) => o.email.toLowerCase()).sort(),
  };
}

/**
 * JSON with object keys sorted, so two equal values always serialize the same way. Needed
 * because Postgres `jsonb` does not keep key order: a snapshot read back from the database
 * would otherwise never equal a freshly built one.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function snapshotsDiffer(
  before: Prisma.JsonValue | null | undefined,
  after: Record<string, unknown>,
): boolean {
  if (!before) return false;
  return canonicalJson(before) !== canonicalJson(after);
}

/** Fingerprint of any value, for "what changed" lists that must not copy personal data. */
export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")
    .slice(0, 16);
}

/** A fresh confirmation link: only the hash is stored, the raw token goes out by email. */
export function newConfirmToken(now: Date): {
  raw: string;
  data: Prisma.OrganizationApplicationOwnerUpdateInput;
} {
  const raw = generateOpaqueToken();
  return {
    raw,
    data: {
      confirmTokenHash: hashOpaqueToken(raw),
      sentAt: now,
      sentCount: { increment: 1 },
      expiresAt: new Date(
        now.getTime() + OWNER_CONFIRM_TTL_DAYS * 24 * 60 * 60 * 1000,
      ),
    },
  };
}

export function nextResendAt(
  candidate: Pick<CandidateRow, "sentAt" | "sentCount" | "status">,
): Date | null {
  if (candidate.status !== OwnerCandidateStatus.PENDING) return null;
  if (!candidate.sentAt) return null;
  return new Date(candidate.sentAt.getTime() + OWNER_CONFIRM_RESEND_COOLDOWN_MS);
}

export function toOwnerCandidateResponse(
  row: CandidateRow,
  submitterEmail: string,
): OwnerCandidateResponse {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    isLegalRep: row.isLegalRep,
    nationalIdDocumentId: row.nationalIdDocumentId,
    status: row.status,
    isSubmitter: row.email === normalizeEmail(submitterEmail),
    respondedAt: row.respondedAt,
    expiresAt: row.expiresAt,
    sentAt: row.sentAt,
    sentCount: row.sentCount,
    nextResendAt: nextResendAt(row),
    declineReason: row.declineReason,
  };
}

interface ProfileShape {
  name?: string | null;
  address?: string | null;
}

/**
 * Mails one confirmation link per candidate. Called after the transaction that minted the
 * tokens has committed, so nobody receives a link to a state that was rolled back. A lost
 * mail is recoverable: the submitter can resend from the tracking page.
 */
export function sendConfirmationEmails(params: {
  issued: { candidate: CandidateRow; rawToken: string }[];
  allOwners: CandidateRow[];
  submitterEmail: string;
  orgType: string | null;
  profile: ProfileShape;
  /** An owner proposing new owners for an existing organization (ADD_OWNER). */
  isAddOwner?: boolean;
}): void {
  for (const { candidate, rawToken } of params.issued) {
    const others = params.allOwners
      .filter((o) => o.id !== candidate.id)
      .map((o) => `${o.fullName} <${o.email}>${o.isLegalRep ? " *" : ""}`)
      .join(", ");
    void enqueueOwnerConfirmationRequestEmail({
      toEmail: candidate.email,
      candidateName: candidate.fullName,
      organizationName: params.profile.name ?? "",
      orgType: params.orgType ?? "",
      address: params.profile.address ?? "",
      submitterEmail: params.submitterEmail,
      otherOwners: others,
      isLegalRep: candidate.isLegalRep,
      confirmUrl: buildOwnerConfirmUrl(rawToken),
      expiresAt: new Date(
        Date.now() + OWNER_CONFIRM_TTL_DAYS * 24 * 60 * 60 * 1000,
      ),
      expiresInDays: OWNER_CONFIRM_TTL_DAYS,
      isAddOwner: Boolean(params.isAddOwner),
    }).catch((err) => {
      console.warn(
        "[organization-application] failed to send an owner confirmation email",
        err,
      );
    });
  }
}
