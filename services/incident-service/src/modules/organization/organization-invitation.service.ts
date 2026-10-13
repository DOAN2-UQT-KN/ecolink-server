import { Prisma } from "@prisma/client";
import {
  InvitationStatus,
  MembershipSource,
  ORG_INVITATION_TTL_DAYS,
  OrgMemberRole,
  OrgPermission,
  hasOrgPermission,
} from "@da2/constants";
import prisma from "../../config/prisma.client";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { generateOpaqueToken, hashOpaqueToken } from "../../utils/token-hash";
import {
  IdentityUserStatus,
  lookupUsersByIds,
  searchUsers,
} from "../organization_application/identity-owner.client";
import { enqueueOrgInvitationEmail } from "../organization_application/organization-application-notify.client";
import { buildOrgInvitationUrl } from "../organization_application/organization-application-urls";
import {
  fetchOrganizationOwnersByUserIds,
  getUserProfile,
} from "./identity-user.client";
import { orgAccessService } from "./org-access.service";
import { organizationMembershipService } from "./organization-membership.service";
import {
  enqueueOrgInvitationPendingWebsiteNotification,
  enqueueOrgInvitationRejectedWebsiteNotification,
} from "./organization-member-notify.client";
import { organizationRepository } from "./organization.repository";

type InvitationRow = Prisma.OrganizationInvitationGetPayload<object>;

const OPEN_STATUSES: string[] = [
  InvitationStatus.PENDING_APPROVAL,
  InvitationStatus.SENT,
];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface InvitationPerson {
  id: string;
  name: string;
  avatar: string | null;
}

export interface InvitationResponse {
  id: string;
  organizationId: string;
  role: string;
  status: string;
  inviter: InvitationPerson;
  invitee: InvitationPerson & { email: string };
  approvedBy: string | null;
  approvedAt: Date | null;
  expiresAt: Date | null;
  respondedAt: Date | null;
  createdAt: Date;
}

export interface InvitationSummaryResponse {
  status: string;
  /** False once the invitation can no longer be answered. */
  active: boolean;
  expired: boolean;
  expiresAt: Date | null;
  role: string;
  organization: {
    id: string;
    name: string;
    slug: string;
    logoUrl: string | null;
    description: string | null;
  };
  inviterName: string;
  inviteeName: string;
  inviteeEmail: string;
  /** A signed-in visitor who is not the invitee; the page warns them. */
  sessionMismatch: boolean;
}

export interface UserSearchResult {
  id: string;
  name: string;
  avatar: string | null;
  /** Masked (`ng***@gmail.com`) unless the caller may propose owners. */
  email: string;
  /** Already holds a role in this organization. */
  isMember: boolean;
  role: string | null;
}

/** `nngtkhngoc05@gmail.com` → `nn***@gmail.com`. Enough to tell two people apart. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

function isExpired(row: Pick<InvitationRow, "status" | "expiresAt">, now = new Date()) {
  return (
    row.status === InvitationStatus.SENT && !!row.expiresAt && row.expiresAt < now
  );
}

/**
 * Member invitations. Anyone in the organization may invite an existing user as MEMBER; if
 * the inviter cannot approve members, the invitation waits for someone who can. Only then is
 * a link mailed, and the invitee still has to accept: nobody joins without agreeing to it.
 */
export class OrganizationInvitationService {
  /**
   * People to invite (or propose as owners). Emails are masked for everyone except callers
   * who may propose owners — they need the full address to fill an ADD_OWNER proposal.
   */
  async searchUsers(
    organizationId: string,
    actorId: string,
    q: string,
  ): Promise<UserSearchResult[]> {
    const actorRole = await orgAccessService.assertOrgPermission(
      organizationId,
      actorId,
      OrgPermission.MEMBER_INVITE,
    );
    const fullEmail = hasOrgPermission(actorRole, OrgPermission.OWNER_PROPOSE);
    const users = await searchUsers(q.trim(), 10);
    const roles = await Promise.all(
      users.map((u) => orgAccessService.getRole(organizationId, u.id)),
    );
    return users.map((user, index) => ({
      id: user.id,
      name: user.name,
      avatar: user.avatar ?? null,
      email: fullEmail ? user.email : maskEmail(user.email),
      isMember: roles[index] !== null,
      role: roles[index],
    }));
  }

  async create(
    organizationId: string,
    actorId: string,
    inviteeUserId: string,
  ): Promise<InvitationResponse> {
    const actorRole = await orgAccessService.assertOrgPermission(
      organizationId,
      actorId,
      OrgPermission.MEMBER_INVITE,
    );
    const organization = await this.loadOrganization(organizationId);

    if (await orgAccessService.getRole(organizationId, inviteeUserId)) {
      throw new HttpError(HTTP_STATUS.ALREADY_MEMBER);
    }
    const invitee = (await lookupUsersByIds([inviteeUserId])).get(inviteeUserId);
    if (!invitee || invitee.status !== IdentityUserStatus.ACTIVE) {
      throw new HttpError(HTTP_STATUS.INVITEE_NOT_AVAILABLE);
    }

    const approved = hasOrgPermission(actorRole, OrgPermission.MEMBER_APPROVE);
    const now = new Date();
    const token = approved ? generateOpaqueToken() : null;

    let row: InvitationRow;
    try {
      row = await prisma.organizationInvitation.create({
        data: {
          organizationId,
          inviterId: actorId,
          inviteeUserId,
          inviteeEmail: invitee.email,
          role: OrgMemberRole.MEMBER,
          status: approved
            ? InvitationStatus.SENT
            : InvitationStatus.PENDING_APPROVAL,
          ...(approved && token
            ? {
                approvedBy: actorId,
                approvedAt: now,
                tokenHash: hashOpaqueToken(token),
                expiresAt: new Date(now.getTime() + ORG_INVITATION_TTL_DAYS * DAY_MS),
              }
            : {}),
        },
      });
    } catch (error) {
      // The partial unique index allows one open invitation per person per organization.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new HttpError(HTTP_STATUS.INVITATION_ALREADY_PENDING);
      }
      throw error;
    }

    const profiles = await fetchOrganizationOwnersByUserIds([actorId, inviteeUserId]);
    const inviterName = getUserProfile(profiles, actorId)?.name ?? "";

    if (token) {
      this.sendInvitationEmail(row, token, organization.name, inviterName, invitee.name);
    } else {
      void orgAccessService
        .userIdsWith(organizationId, OrgPermission.MEMBER_APPROVE)
        .then((approverIds) =>
          enqueueOrgInvitationPendingWebsiteNotification({
            userIds: approverIds,
            organizationId,
            organizationName: organization.name,
            organizationSlug: organization.slug,
            inviterName,
            inviteeName: invitee.name,
          }),
        )
        .catch((err) => {
          console.warn("[org-invitation] failed to notify approvers", err);
        });
    }

    // A member only ever saw the masked email in the picker; don't reveal it here.
    return (await this.toResponses([row], approved))[0];
  }

  /** Approvers see every invitation; everyone else only the ones they sent. */
  async list(
    organizationId: string,
    actorId: string,
    status?: string,
  ): Promise<InvitationResponse[]> {
    const actorRole = await orgAccessService.assertOrgPermission(
      organizationId,
      actorId,
      OrgPermission.MEMBER_INVITE,
    );
    const canApprove = hasOrgPermission(actorRole, OrgPermission.MEMBER_APPROVE);
    const rows = await prisma.organizationInvitation.findMany({
      where: {
        organizationId,
        ...(status ? { status } : {}),
        ...(canApprove ? {} : { inviterId: actorId }),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return this.toResponses(rows, canApprove);
  }

  async approve(
    organizationId: string,
    invitationId: string,
    actorId: string,
  ): Promise<InvitationResponse> {
    await orgAccessService.assertOrgPermission(
      organizationId,
      actorId,
      OrgPermission.MEMBER_APPROVE,
    );
    const organization = await this.loadOrganization(organizationId);
    const token = generateOpaqueToken();
    const now = new Date();

    const row = await prisma.$transaction(async (tx) => {
      const current = await this.lockInvitation(tx, organizationId, invitationId);
      if (current.status !== InvitationStatus.PENDING_APPROVAL) {
        throw new HttpError(HTTP_STATUS.INVITATION_NOT_ACTIVE);
      }
      // The invitee may have joined another way while this waited.
      const role = await tx.organizationMember.findFirst({
        where: { organizationId, userId: current.inviteeUserId, deletedAt: null },
        select: { role: true },
      });
      if (role) {
        await tx.organizationInvitation.update({
          where: { id: current.id },
          data: { status: InvitationStatus.CANCELLED, respondedAt: now },
        });
        throw new HttpError(HTTP_STATUS.ALREADY_MEMBER);
      }
      return tx.organizationInvitation.update({
        where: { id: current.id },
        data: {
          status: InvitationStatus.SENT,
          approvedBy: actorId,
          approvedAt: now,
          tokenHash: hashOpaqueToken(token),
          expiresAt: new Date(now.getTime() + ORG_INVITATION_TTL_DAYS * DAY_MS),
        },
      });
    });

    const profiles = await fetchOrganizationOwnersByUserIds([
      row.inviterId,
      row.inviteeUserId,
    ]);
    this.sendInvitationEmail(
      row,
      token,
      organization.name,
      getUserProfile(profiles, row.inviterId)?.name ?? "",
      getUserProfile(profiles, row.inviteeUserId)?.name ?? "",
    );
    return (await this.toResponses([row], true))[0];
  }

  async reject(
    organizationId: string,
    invitationId: string,
    actorId: string,
  ): Promise<InvitationResponse> {
    await orgAccessService.assertOrgPermission(
      organizationId,
      actorId,
      OrgPermission.MEMBER_APPROVE,
    );
    const organization = await this.loadOrganization(organizationId);
    const row = await prisma.$transaction(async (tx) => {
      const current = await this.lockInvitation(tx, organizationId, invitationId);
      if (current.status !== InvitationStatus.PENDING_APPROVAL) {
        throw new HttpError(HTTP_STATUS.INVITATION_NOT_ACTIVE);
      }
      return tx.organizationInvitation.update({
        where: { id: current.id },
        data: {
          status: InvitationStatus.REJECTED,
          approvedBy: actorId,
          respondedAt: new Date(),
        },
      });
    });

    const profiles = await fetchOrganizationOwnersByUserIds([row.inviteeUserId]);
    void enqueueOrgInvitationRejectedWebsiteNotification({
      userId: row.inviterId,
      organizationId,
      organizationName: organization.name,
      organizationSlug: organization.slug,
      inviteeName: getUserProfile(profiles, row.inviteeUserId)?.name ?? "",
    }).catch((err) => {
      console.warn("[org-invitation] failed to notify the inviter of a rejection", err);
    });
    return (await this.toResponses([row], true))[0];
  }

  /** The inviter, or anyone who may approve, can take back an open invitation. */
  async cancel(
    organizationId: string,
    invitationId: string,
    actorId: string,
  ): Promise<void> {
    const actorRole = await orgAccessService.getRole(organizationId, actorId);
    await prisma.$transaction(async (tx) => {
      const current = await this.lockInvitation(tx, organizationId, invitationId);
      const allowed =
        current.inviterId === actorId ||
        hasOrgPermission(actorRole, OrgPermission.MEMBER_APPROVE);
      if (!allowed) {
        throw new HttpError(HTTP_STATUS.ORG_PERMISSION_DENIED);
      }
      if (!OPEN_STATUSES.includes(current.status)) {
        throw new HttpError(HTTP_STATUS.INVITATION_NOT_ACTIVE);
      }
      await tx.organizationInvitation.update({
        where: { id: current.id },
        data: { status: InvitationStatus.CANCELLED, respondedAt: new Date() },
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Public, by token                                                    */
  /* ------------------------------------------------------------------ */

  async getByToken(
    rawToken: string,
    sessionUserId?: string | null,
  ): Promise<InvitationSummaryResponse> {
    const row = await this.findByToken(rawToken);
    const organization = await this.loadOrganization(row.organizationId);
    const profiles = await fetchOrganizationOwnersByUserIds([
      row.inviterId,
      row.inviteeUserId,
    ]);
    const expired = row.status === InvitationStatus.EXPIRED || isExpired(row);
    return {
      status: expired ? InvitationStatus.EXPIRED : row.status,
      active: row.status === InvitationStatus.SENT && !expired,
      expired,
      expiresAt: row.expiresAt,
      role: row.role,
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        logoUrl: organization.logoUrl,
        description: organization.descriptionVi ?? organization.description ?? null,
      },
      inviterName: getUserProfile(profiles, row.inviterId)?.name ?? "",
      inviteeName: getUserProfile(profiles, row.inviteeUserId)?.name ?? "",
      inviteeEmail: maskEmail(row.inviteeEmail),
      sessionMismatch: !!sessionUserId && sessionUserId !== row.inviteeUserId,
    };
  }

  /**
   * Owning the mailbox the link went to is the consent. Idempotent: accepting twice, or
   * after having joined some other way, just reports success.
   */
  async accept(rawToken: string): Promise<{ organizationSlug: string }> {
    const found = await this.findByToken(rawToken);
    const organization = await this.loadOrganization(found.organizationId);

    await prisma.$transaction(async (tx) => {
      const current = await this.lockInvitation(tx, found.organizationId, found.id);
      if (current.status === InvitationStatus.ACCEPTED) return;
      if (current.status !== InvitationStatus.SENT) {
        throw new HttpError(HTTP_STATUS.INVITATION_NOT_ACTIVE);
      }
      if (isExpired(current)) {
        await tx.organizationInvitation.update({
          where: { id: current.id },
          data: { status: InvitationStatus.EXPIRED },
        });
        throw new HttpError(HTTP_STATUS.INVITATION_EXPIRED);
      }

      const existing = await tx.organizationMember.findFirst({
        where: {
          organizationId: current.organizationId,
          userId: current.inviteeUserId,
          deletedAt: null,
        },
        select: { role: true },
      });
      // Never downgrade someone who joined with a higher role in the meantime.
      if (!existing) {
        await organizationMembershipService.grantMembership(tx, {
          userId: current.inviteeUserId,
          organizationId: current.organizationId,
          role: current.role as OrgMemberRole,
          source: MembershipSource.INVITATION,
          sourceRef: current.id,
          actorId: current.inviteeUserId,
        });
      }
      await tx.organizationInvitation.update({
        where: { id: current.id },
        data: { status: InvitationStatus.ACCEPTED, respondedAt: new Date() },
      });
    });

    return { organizationSlug: organization.slug };
  }

  async decline(rawToken: string): Promise<void> {
    const found = await this.findByToken(rawToken);
    await prisma.$transaction(async (tx) => {
      const current = await this.lockInvitation(tx, found.organizationId, found.id);
      if (current.status === InvitationStatus.DECLINED) return;
      if (current.status !== InvitationStatus.SENT) {
        throw new HttpError(HTTP_STATUS.INVITATION_NOT_ACTIVE);
      }
      await tx.organizationInvitation.update({
        where: { id: current.id },
        data: { status: InvitationStatus.DECLINED, respondedAt: new Date() },
      });
    });
  }

  /** Hourly sweep: approved links that ran out become EXPIRED. */
  async expireOverdue(now = new Date()): Promise<number> {
    const result = await prisma.organizationInvitation.updateMany({
      where: { status: InvitationStatus.SENT, expiresAt: { lt: now } },
      data: { status: InvitationStatus.EXPIRED },
    });
    return result.count;
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  private async loadOrganization(organizationId: string) {
    const organization = await organizationRepository.findById(organizationId);
    if (!organization) {
      throw new HttpError(HTTP_STATUS.NOT_FOUND.withMessage("Organization not found"));
    }
    return organization;
  }

  private async lockInvitation(
    tx: Prisma.TransactionClient,
    organizationId: string,
    invitationId: string,
  ): Promise<InvitationRow> {
    await tx.$queryRaw`SELECT id FROM "organization_invitations" WHERE id = ${invitationId}::uuid FOR UPDATE`;
    const row = await tx.organizationInvitation.findUnique({
      where: { id: invitationId },
    });
    if (!row || row.organizationId !== organizationId) {
      throw new HttpError(HTTP_STATUS.INVITATION_NOT_FOUND);
    }
    return row;
  }

  private async findByToken(rawToken: string): Promise<InvitationRow> {
    const token = rawToken?.trim();
    if (!token) throw new HttpError(HTTP_STATUS.INVITATION_NOT_FOUND);
    const row = await prisma.organizationInvitation.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
    });
    if (!row) throw new HttpError(HTTP_STATUS.INVITATION_NOT_FOUND);
    return row;
  }

  private sendInvitationEmail(
    row: InvitationRow,
    token: string,
    organizationName: string,
    inviterName: string,
    inviteeName: string,
  ): void {
    void enqueueOrgInvitationEmail({
      toEmail: row.inviteeEmail,
      inviteeName,
      inviterName,
      organizationName,
      invitationUrl: buildOrgInvitationUrl(token),
      expiresInDays: ORG_INVITATION_TTL_DAYS,
    }).catch((err) => {
      console.warn("[org-invitation] failed to send the invitation email", err);
    });
  }

  private async toResponses(
    rows: InvitationRow[],
    showFullEmail: boolean,
  ): Promise<InvitationResponse[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.inviterId, r.inviteeUserId]))];
    const profiles = await fetchOrganizationOwnersByUserIds(ids);
    const person = (id: string): InvitationPerson => {
      const profile = getUserProfile(profiles, id);
      return { id, name: profile?.name ?? "", avatar: profile?.avatar ?? null };
    };
    const now = new Date();
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      role: row.role,
      status: isExpired(row, now) ? InvitationStatus.EXPIRED : row.status,
      inviter: person(row.inviterId),
      invitee: {
        ...person(row.inviteeUserId),
        email: showFullEmail ? row.inviteeEmail : maskEmail(row.inviteeEmail),
      },
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt,
      expiresAt: row.expiresAt,
      respondedAt: row.respondedAt,
      createdAt: row.createdAt,
    }));
  }
}

export const organizationInvitationService = new OrganizationInvitationService();
