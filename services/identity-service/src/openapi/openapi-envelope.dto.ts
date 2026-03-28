import type { CurrentUserResponse } from "../modules/auth/auth.dto";
import type { PermissionSetResponse, RoleResponse } from "../modules/role/role.dto";
import type { UserResponse } from "../modules/user/user.dto";

export interface UserOneEnvelopeData {
  user: UserResponse;
}

export interface UsersListEnvelopeData {
  users: UserResponse[];
}

export interface RoleOneEnvelopeData {
  role: RoleResponse;
}

export interface RolesListEnvelopeData {
  roles: RoleResponse[];
}

export interface PermissionSetOneEnvelopeData {
  permissionSet: PermissionSetResponse;
}

export interface PermissionSetsListEnvelopeData {
  permissionSets: PermissionSetResponse[];
}

export interface PermissionsEnumListData {
  permissions: string[];
}

export interface PasswordResetTokenData {
  resetToken: string;
}

export interface MeUserData {
  user: CurrentUserResponse;
}
