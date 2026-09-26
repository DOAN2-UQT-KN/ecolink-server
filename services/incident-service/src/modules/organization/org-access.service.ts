import {
  OrgPermission,
  OrgPermissionSet,
  hasOrgPermission,
  permissionsFor,
} from "@da2/constants";
import { HTTP_STATUS, HttpError } from "../../constants/http-status";
import { organizationMemberRepository } from "./organization_member.repository";

/**
 * Resolves what a user may do in an organization, from their membership role and the matrix
 * in `@da2/constants/org-permissions`. Every organization-management check goes through here
 * so the rules live in one place. Read from the database on each request: there is no
 * organization context in the JWT, so a role change takes effect immediately.
 */
export class OrgAccessService {
  getRole(organizationId: string, userId: string): Promise<string | null> {
    return organizationMemberRepository.findActiveRole(organizationId, userId);
  }

  async can(
    organizationId: string,
    userId: string,
    permission: OrgPermission,
  ): Promise<boolean> {
    return hasOrgPermission(await this.getRole(organizationId, userId), permission);
  }

  /** Returns the caller's role so the handler can apply finer rules (e.g. `canActOnMember`). */
  async assertOrgPermission(
    organizationId: string,
    userId: string,
    permission: OrgPermission,
  ): Promise<string> {
    const role = await this.getRole(organizationId, userId);
    if (!role || !hasOrgPermission(role, permission)) {
      throw new HttpError(HTTP_STATUS.ORG_PERMISSION_DENIED);
    }
    return role;
  }

  permissionsFor(role: string | null | undefined): OrgPermissionSet {
    return permissionsFor(role);
  }

  /** Users holding a permission in the organization, e.g. everyone who may approve members. */
  async userIdsWith(
    organizationId: string,
    permission: OrgPermission,
  ): Promise<string[]> {
    const members =
      await organizationMemberRepository.findAllActiveByOrganization(organizationId);
    return members
      .filter((member) => hasOrgPermission(member.role, permission))
      .map((member) => member.userId);
  }
}

export const orgAccessService = new OrgAccessService();
