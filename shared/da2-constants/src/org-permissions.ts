import { OrgMemberRole, isOwnerRole } from "./organization-trust";

/**
 * What a member may do inside one organization. The single source of truth for the role
 * matrix: incident-service enforces it, and the API hands the resolved set to the client as
 * `permissions`, so the UI never re-derives the rules on its own.
 */
export enum OrgPermission {
  /** Edit the profile, resend the contact-email verification. */
  ORG_EDIT = "ORG_EDIT",
  /** Approve or reject join requests and member invitations. */
  MEMBER_APPROVE = "MEMBER_APPROVE",
  /** Invite someone as MEMBER (the invitation still needs MEMBER_APPROVE). */
  MEMBER_INVITE = "MEMBER_INVITE",
  /** Change a member's role or remove them (bounded by `canActOnMember`). */
  MEMBER_MANAGE = "MEMBER_MANAGE",
  /** Propose new owners (ADD_OWNER application). */
  OWNER_PROPOSE = "OWNER_PROPOSE",
  /** Declared now, enforced in phase 4 (campaign permissions). */
  CAMPAIGN_CREATE = "CAMPAIGN_CREATE",
  CAMPAIGN_MANAGE_ANY = "CAMPAIGN_MANAGE_ANY",
}

const OWNER_PERMISSIONS: readonly OrgPermission[] = Object.values(OrgPermission);

const ROLE_PERMISSIONS: Record<OrgMemberRole, readonly OrgPermission[]> = {
  [OrgMemberRole.LEGAL_REPRESENTATIVE]: OWNER_PERMISSIONS,
  [OrgMemberRole.OWNER]: OWNER_PERMISSIONS,
  [OrgMemberRole.ADMIN]: [
    OrgPermission.ORG_EDIT,
    OrgPermission.MEMBER_APPROVE,
    OrgPermission.MEMBER_INVITE,
    OrgPermission.MEMBER_MANAGE,
    OrgPermission.CAMPAIGN_CREATE,
    OrgPermission.CAMPAIGN_MANAGE_ANY,
  ],
  [OrgMemberRole.CAMPAIGN_MANAGER]: [
    OrgPermission.MEMBER_INVITE,
    OrgPermission.CAMPAIGN_CREATE,
  ],
  [OrgMemberRole.MEMBER]: [OrgPermission.MEMBER_INVITE],
};

export function hasOrgPermission(
  role: string | null | undefined,
  permission: OrgPermission,
): boolean {
  if (!role) return false;
  return (ROLE_PERMISSIONS[role as OrgMemberRole] ?? []).includes(permission);
}

/**
 * Roles an actor may hand out through "change role". Owners and the legal representative
 * are never assignable here: becoming an owner goes through an ADD_OWNER application, and
 * losing it is phase 3.
 */
export function assignableRoles(actorRole: string | null | undefined): OrgMemberRole[] {
  if (isOwnerRole(actorRole)) {
    return [OrgMemberRole.ADMIN, OrgMemberRole.CAMPAIGN_MANAGER, OrgMemberRole.MEMBER];
  }
  if (actorRole === OrgMemberRole.ADMIN) {
    return [OrgMemberRole.CAMPAIGN_MANAGER, OrgMemberRole.MEMBER];
  }
  return [];
}

/**
 * Whether the actor may change the role of, or remove, a member currently holding
 * `targetRole`. Owners are untouchable in this phase; an admin cannot act on another admin.
 */
export function canActOnMember(
  actorRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  if (!hasOrgPermission(actorRole, OrgPermission.MEMBER_MANAGE)) return false;
  if (!targetRole || isOwnerRole(targetRole)) return false;
  if (actorRole === OrgMemberRole.ADMIN && targetRole === OrgMemberRole.ADMIN) {
    return false;
  }
  return true;
}

/** The resolved permission set sent to the client. */
export interface OrgPermissionSet {
  canEditOrg: boolean;
  canApproveMembers: boolean;
  canInvite: boolean;
  canManageMembers: boolean;
  canProposeOwners: boolean;
  canCreateCampaign: boolean;
  canManageAllCampaigns: boolean;
  /** Roles this viewer may assign through "change role". */
  assignableRoles: OrgMemberRole[];
}

export function permissionsFor(role: string | null | undefined): OrgPermissionSet {
  return {
    canEditOrg: hasOrgPermission(role, OrgPermission.ORG_EDIT),
    canApproveMembers: hasOrgPermission(role, OrgPermission.MEMBER_APPROVE),
    canInvite: hasOrgPermission(role, OrgPermission.MEMBER_INVITE),
    canManageMembers: hasOrgPermission(role, OrgPermission.MEMBER_MANAGE),
    canProposeOwners: hasOrgPermission(role, OrgPermission.OWNER_PROPOSE),
    canCreateCampaign: hasOrgPermission(role, OrgPermission.CAMPAIGN_CREATE),
    canManageAllCampaigns: hasOrgPermission(role, OrgPermission.CAMPAIGN_MANAGE_ANY),
    assignableRoles: assignableRoles(role),
  };
}
