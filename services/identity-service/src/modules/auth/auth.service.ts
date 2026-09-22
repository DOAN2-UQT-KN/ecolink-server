import bcrypt from "bcryptjs";
import { AuthTokenType } from "../../constants/auth-token-type";
import { AccountType, UserStatus } from "../../constants/user-status";
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from "../../utils/token-hash";
import {
  generateTokens,
  getJwtExpiresAt,
  verifyToken,
} from "../../utils/jwt.utils";
import { userRepository } from "../user/user.repository";
import { roleRepository } from "../role/role.repository";
import { authTokenRepository } from "./auth_token.repository";
import { mergeNotificationPreferences } from "@da2/constants";
import {
  SignupRequest,
  SignupResponse,
  LoginRequest,
  LoginResponse,
  CurrentUserResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
  UpdatePasswordRequest,
  RequestPasswordResetRequest,
  ResetPasswordRequest,
} from "./auth.dto";

const PASSWORD_RESET_TTL_MS = (() => {
  const raw = process.env.PASSWORD_RESET_TTL_MS;
  if (raw == null || raw === "") {
    return 3_600_000;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 3_600_000;
})();

/** Role every provisioned organization account is given. */
const ORG_OWNER_ROLE_NAME = "ORG_OWNER";

const ORG_ACCOUNT_ACTIVATION_TTL_MS = (() => {
  const raw = process.env.ORG_ACCOUNT_ACTIVATION_TTL_MS;
  if (raw == null || raw === "") {
    return 72 * 3_600_000;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 72 * 3_600_000;
})();

const ORG_CONTACT_EMAIL_TTL_MS = (() => {
  const raw = process.env.ORG_CONTACT_EMAIL_TOKEN_TTL_MS;
  if (raw == null || raw === "") {
    return 72 * 3_600_000;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 72 * 3_600_000;
})();

export class AuthService {
  constructor() {}

  async signup(request: SignupRequest): Promise<SignupResponse> {
    // Check if user already exists
    const existing = await userRepository.findByEmail(request.email);
    if (existing) {
      throw new Error("User with this email already exists");
    }

    // Get Role ID
    let roleId = request.roleId;
    if (!roleId) {
      const defaultRole = await roleRepository.findRoleByName("USER");
      if (!defaultRole) {
        throw new Error("You are missing role");
      }
      roleId = defaultRole.id;
    }
    // Hash password
    const hashedPassword = await bcrypt.hash(request.password, 10);

    // Create user directly (single table, no HTTP call)
    const user = await userRepository.create({
      email: request.email,
      name: request.name,
      password: hashedPassword,
      avatar: null,
      bio: null,
      role: { connect: { id: roleId } },
      emailVerified: false,
      verificationToken: null,
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roleId: user.roleId,
      avatar: user.avatar,
      bio: user.bio,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async login(request: LoginRequest): Promise<LoginResponse | null> {
    const user = await userRepository.findByEmail(request.email);
    if (!user) {
      return null;
    }

    if (user.status === UserStatus.INACTIVE) {
      throw new Error("ACCOUNT_BANNED");
    }

    if (user.status === UserStatus.PENDING_ACTIVATION) {
      throw new Error("ACCOUNT_PENDING_ACTIVATION");
    }

    // Provisioned org accounts have no password until the activation link is redeemed;
    // bcrypt.compare would throw on a null hash.
    if (!user.password) {
      return null;
    }

    const isValid = await bcrypt.compare(request.password, user.password);
    if (!isValid) {
      return null;
    }

    const role = await roleRepository.findRoleById(user.roleId);
    // Generate tokens
    const tokens = generateTokens({
      userId: user.id,
      email: user.email,
      role: role?.name ?? "USER",
    });

    const refreshExpiresAt = getJwtExpiresAt(tokens.refreshToken);
    if (refreshExpiresAt) {
      await authTokenRepository.create({
        userId: user.id,
        type: AuthTokenType.REFRESH,
        tokenHash: hashOpaqueToken(tokens.refreshToken),
        expiresAt: refreshExpiresAt,
      });
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roleId: user.roleId,
        avatar: user.avatar,
        bio: user.bio,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async refreshAccessToken(
    refreshTokenRequest: RefreshTokenRequest,
  ): Promise<RefreshTokenResponse | null> {
    try {
      const refreshToken = refreshTokenRequest.refreshToken;
      const decoded = verifyToken(refreshToken);

      const stored = await authTokenRepository.findActiveByHashAndType(
        hashOpaqueToken(refreshToken),
        AuthTokenType.REFRESH,
      );
      if (!stored || stored.userId !== decoded.userId) {
        return null;
      }

      const user = await userRepository.findById(decoded.userId);
      if (!user) {
        return null;
      }

      await authTokenRepository.revokeById(stored.id);

      const tokens = generateTokens({
        userId: user.id,
        email: user.email,
        role: user.roleId,
      });

      const refreshExpiresAt = getJwtExpiresAt(tokens.refreshToken);
      if (refreshExpiresAt) {
        await authTokenRepository.create({
          userId: user.id,
          type: AuthTokenType.REFRESH,
          tokenHash: hashOpaqueToken(tokens.refreshToken),
          expiresAt: refreshExpiresAt,
        });
      }

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          roleId: user.roleId,
        },
      };
    } catch (error) {
      console.error("Token refresh error:", error);
      return null;
    }
  }

  async updatePassword(request: UpdatePasswordRequest): Promise<boolean> {
    const user = await userRepository.findById(request.userId);
    if (!user || !user.password) {
      return false;
    }

    const isValid = await bcrypt.compare(request.oldPassword, user.password);
    if (!isValid) {
      return false;
    }

    const hashedPassword = await bcrypt.hash(request.newPassword, 10);
    await userRepository.update(user.id, { password: hashedPassword });

    await authTokenRepository.revokeAllForUser(user.id, AuthTokenType.REFRESH);

    return true;
  }

  async requestPasswordReset(
    request: RequestPasswordResetRequest,
  ): Promise<string | null> {
    const user = await userRepository.findByEmail(request.email);
    if (!user) {
      return null;
    }

    await authTokenRepository.revokeAllForUser(
      user.id,
      AuthTokenType.PASSWORD_RESET,
    );

    const plainToken = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    await authTokenRepository.create({
      userId: user.id,
      type: AuthTokenType.PASSWORD_RESET,
      tokenHash: hashOpaqueToken(plainToken),
      expiresAt,
    });

    return plainToken;
  }

  async resetPassword(request: ResetPasswordRequest): Promise<boolean> {
    const stored = await authTokenRepository.findActiveByHashAndType(
      hashOpaqueToken(request.resetToken),
      AuthTokenType.PASSWORD_RESET,
    );
    if (!stored) {
      return false;
    }

    const user = await userRepository.findById(stored.userId);
    if (!user) {
      return false;
    }

    const hashedPassword = await bcrypt.hash(request.newPassword, 10);
    await userRepository.update(user.id, { password: hashedPassword });

    await authTokenRepository.markUsed(stored.id);
    await authTokenRepository.revokeAllForUser(user.id, AuthTokenType.REFRESH);

    return true;
  }

  async getMe(userId: string): Promise<CurrentUserResponse | null> {
    const user = await userRepository.findCurrentUserById(userId);
    if (!user) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roleId: user.roleId,
      avatar: user.avatar,
      bio: user.bio,
      phoneNumber: user.phoneNumber ?? null,
      gender: (user.gender as CurrentUserResponse['gender']) ?? null,
      dateOfBirth: user.dateOfBirth ?? null,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      latitude: user.latitude,
      longitude: user.longitude,
      locationUpdatedAt: user.locationUpdatedAt,
      detailAddress: user.detailAddress ?? null,
      notificationPreferences: mergeNotificationPreferences(
        user.notificationPreferences,
      ),
    };
  }

  async logout(userId: string): Promise<void> {
    const user = await userRepository.findById(userId);
    if (!user) {
      return;
    }

    await authTokenRepository.revokeAllForUser(userId, AuthTokenType.REFRESH);
  }

  /**
   * Server-to-server: issue an opaque token for organization contact email verification (incident-service).
   */
  async createOrganizationContactEmailToken(params: {
    organizationId: string;
    contactEmail: string;
    ownerUserId: string;
  }): Promise<string> {
    const owner = await userRepository.findById(params.ownerUserId);
    if (!owner) {
      throw new Error("Owner user not found");
    }

    const emailNorm = params.contactEmail.trim().toLowerCase();
    await authTokenRepository.revokeActiveOrganizationContactEmail(
      params.organizationId,
    );

    const plainToken = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + ORG_CONTACT_EMAIL_TTL_MS);

    await authTokenRepository.create({
      userId: params.ownerUserId,
      type: AuthTokenType.ORGANIZATION_CONTACT_EMAIL,
      tokenHash: hashOpaqueToken(plainToken),
      expiresAt,
      metadata: {
        organizationId: params.organizationId,
        contactEmail: emailNorm,
      },
    });

    return plainToken;
  }

  /**
   * Server-to-server: create (or return) the single login that operates an organization.
   *
   * Idempotent on `applicationId`, not on the email. incident-service reaches this through the
   * outbox relay, which retries whenever identity is unreachable, so a second call for the
   * same application must hand back the account the first one made instead of creating a
   * duplicate. The account starts with no password and status PENDING_ACTIVATION; only the
   * activation link can turn it into something that can log in.
   */
  async provisionOrgAccount(params: {
    applicationId: string;
    organizationId: string;
    email: string;
    displayName: string;
  }): Promise<{
    userId: string;
    activationToken: string | null;
    alreadyProvisioned: boolean;
  }> {
    const email = params.email.trim().toLowerCase();

    const existing = await userRepository.findByProvisionedApplicationId(
      params.applicationId,
    );
    if (existing) {
      return {
        userId: existing.id,
        activationToken: null,
        alreadyProvisioned: true,
      };
    }

    const emailTaken = await userRepository.findByEmail(email);
    if (emailTaken) {
      throw new Error("ORG_ACCOUNT_EMAIL_TAKEN");
    }

    const role = await roleRepository.findRoleByName(ORG_OWNER_ROLE_NAME);
    if (!role) {
      throw new Error(`${ORG_OWNER_ROLE_NAME} role not found`);
    }

    const user = await userRepository.create({
      email,
      name: params.displayName,
      password: null,
      accountType: AccountType.ORG,
      provisionedFromApplicationId: params.applicationId,
      status: UserStatus.PENDING_ACTIVATION,
      emailVerified: true,
      role: { connect: { id: role.id } },
    });

    const activationToken = await this.issueOrgActivationToken(user.id, {
      organizationId: params.organizationId,
      applicationId: params.applicationId,
    });

    return { userId: user.id, activationToken, alreadyProvisioned: false };
  }

  /** Single-use link that lets an org account set its first password. */
  async issueOrgActivationToken(
    userId: string,
    metadata: { organizationId: string; applicationId: string },
  ): Promise<string> {
    await authTokenRepository.revokeAllForUser(
      userId,
      AuthTokenType.ORG_ACCOUNT_ACTIVATION,
    );

    const plainToken = generateOpaqueToken();
    await authTokenRepository.create({
      userId,
      type: AuthTokenType.ORG_ACCOUNT_ACTIVATION,
      tokenHash: hashOpaqueToken(plainToken),
      expiresAt: new Date(Date.now() + ORG_ACCOUNT_ACTIVATION_TTL_MS),
      metadata,
    });
    return plainToken;
  }

  /**
   * Redeems an activation link: sets the first password and lifts the account out of
   * PENDING_ACTIVATION. Deliberately a link rather than a temporary password — a password
   * mailed in plain text stays readable in that inbox forever.
   */
  async activateOrgAccount(
    plainToken: string,
    newPassword: string,
  ): Promise<boolean> {
    const trimmed = plainToken.trim();
    if (!trimmed) {
      return false;
    }

    const stored = await authTokenRepository.findActiveByHashAndType(
      hashOpaqueToken(trimmed),
      AuthTokenType.ORG_ACCOUNT_ACTIVATION,
    );
    if (!stored) {
      return false;
    }

    const user = await userRepository.findById(stored.userId);
    if (!user) {
      return false;
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await userRepository.update(user.id, {
      password: hashedPassword,
      status: UserStatus.ACTIVE,
    });

    await authTokenRepository.markUsed(stored.id);
    await authTokenRepository.revokeAllForUser(user.id, AuthTokenType.REFRESH);

    return true;
  }

  /**
   * Validates token, marks it used, returns payload. One-time use.
   */
  async verifyAndConsumeOrganizationContactEmailToken(
    plainToken: string,
  ): Promise<{ organizationId: string; contactEmail: string } | null> {
    const trimmed = plainToken.trim();
    if (!trimmed) {
      return null;
    }

    const stored = await authTokenRepository.findActiveByHashAndType(
      hashOpaqueToken(trimmed),
      AuthTokenType.ORGANIZATION_CONTACT_EMAIL,
    );
    if (!stored) {
      return null;
    }

    const meta = stored.metadata as {
      organizationId?: string;
      contactEmail?: string;
    } | null;
    if (!meta?.organizationId || !meta?.contactEmail) {
      return null;
    }

    await authTokenRepository.markUsed(stored.id);

    return {
      organizationId: meta.organizationId,
      contactEmail: meta.contactEmail.trim().toLowerCase(),
    };
  }
}

// Singleton instance
export const authService = new AuthService();
