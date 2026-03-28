import type { OpenapiRouteModels } from "@da2/express-swagger";

export const OPENAPI_ROUTE_MODELS: OpenapiRouteModels = {
  "POST /api/v1/auth/sign-up": {
    requestBody: "SignupRequest",
    responseData: "SignupResponse",
  },
  "POST /api/v1/auth/sign-in": {
    requestBody: "LoginRequest",
    responseData: "LoginResponse",
  },
  "POST /api/v1/auth/refresh-token": {
    requestBody: "RefreshTokenBody",
    responseData: "RefreshTokenResponse",
  },
  "POST /api/v1/auth/update-password": {
    requestBody: "AuthUpdatePasswordBody",
    omitData: true,
  },
  "POST /api/v1/auth/request-password-reset": {
    requestBody: "RequestPasswordResetRequest",
    responseData: "PasswordResetTokenData",
  },
  "POST /api/v1/auth/reset-password": {
    requestBody: "ResetPasswordRequest",
    omitData: true,
  },
  "GET /api/v1/auth/me": {
    responseData: "MeUserData",
  },
  "POST /api/v1/auth/logout": {
    omitData: true,
  },

  "GET /api/v1/users": {
    responseData: "UsersListEnvelopeData",
  },
  "GET /api/v1/users/:id": {
    responseData: "UserOneEnvelopeData",
  },
  "GET /api/v1/users/email/:email": {
    responseData: "UserOneEnvelopeData",
  },
  "PUT /api/v1/users/:id": {
    requestBody: "UpdateUserRequest",
    responseData: "UserOneEnvelopeData",
  },
  "DELETE /api/v1/users/:id": {
    omitData: true,
  },

  "POST /api/v1/roles": {
    requestBody: "CreateRoleRequest",
    responseData: "RoleOneEnvelopeData",
  },
  "GET /api/v1/roles": {
    responseData: "RolesListEnvelopeData",
  },
  "GET /api/v1/roles/permissions": {
    responseData: "PermissionsEnumListData",
  },
  "GET /api/v1/roles/:id": {
    responseData: "RoleOneEnvelopeData",
  },
  "PUT /api/v1/roles/:id": {
    requestBody: "UpdateRoleRequest",
    responseData: "RoleOneEnvelopeData",
  },
  "DELETE /api/v1/roles/:id": {
    omitData: true,
  },
  "POST /api/v1/roles/permission-sets": {
    requestBody: "CreatePermissionSetRequest",
    responseData: "PermissionSetOneEnvelopeData",
  },
  "GET /api/v1/roles/permission-sets": {
    responseData: "PermissionSetsListEnvelopeData",
  },
  "GET /api/v1/roles/permission-sets/:id": {
    responseData: "PermissionSetOneEnvelopeData",
  },
  "PUT /api/v1/roles/permission-sets/:id": {
    requestBody: "UpdatePermissionSetRequest",
    responseData: "PermissionSetOneEnvelopeData",
  },
  "DELETE /api/v1/roles/permission-sets/:id": {
    omitData: true,
  },
};
