import bcrypt from "bcryptjs";
import { AuthTokenType } from "../../constants/auth-token-type";
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
      roleId: roleId,
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
    if (!user) {
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
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
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
