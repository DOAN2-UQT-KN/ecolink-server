import bcrypt from "bcryptjs";
import { AuthTokenType } from "../../constants/auth-token-type";
import { UserStatus } from "../../constants/user-status";
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
import type { UserEntity } from "../user/user.entity";
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

/** Role given to accounts created for approved organization owners — an ordinary person. */
const DEFAULT_ROLE_NAME = "USER";

/** Self-service resends of the activation email per user per hour. */
const MAX_ACTIVATION_RESENDS_PER_HOUR = 3;

const ACCOUNT_ACTIVATION_TTL_MS = (() => {
  const raw =
    process.env.ACCOUNT_ACTIVATION_TTL_MS ??
    process.env.ORG_ACCOUNT_ACTIVATION_TTL_MS;
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

    // Accounts created for approved owners have no password until the activation link is
    // redeemed; bcrypt.compare would throw on a null hash.
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

      // The role *name*, as at login. Putting the role id here made every `role === "admin"`
      // check fail after the first refresh.
      const role = await roleRepository.findRoleById(user.roleId);
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
   * Server-to-server: one person account per email, created when missing.
   *
   * Used when an organization application is approved. Existing accounts are returned as
   * they are — the owner confirmed by email, so their consent is proven and the account's
   * history (reports, points) stays attached to the same person. Missing ones are created
   * with no password in PENDING_ACTIVATION. Idempotent on the email, so a retried approval
   * gets the same users back.
   */
  async ensureUsersForOwners(
    owners: { email: string; fullName: string }[],
  ): Promise<UserEntity[]> {
    const wanted = new Map<string, string>();
    for (const owner of owners) {
      const email = owner.email.trim().toLowerCase();
      if (email && !wanted.has(email)) {
        wanted.set(email, owner.fullName.trim() || email.split("@")[0]);
      }
    }

    const existing = await userRepository.findManyByEmails([...wanted.keys()]);
    const found = new Map(existing.map((u) => [u.email.toLowerCase(), u]));
    const missing = [...wanted.keys()].filter((email) => !found.has(email));
    if (missing.length === 0) {
      return [...found.values()];
    }

    const role = await roleRepository.findRoleByName(DEFAULT_ROLE_NAME);
    if (!role) {
      throw new Error(`${DEFAULT_ROLE_NAME} role not found`);
    }

    for (const email of missing) {
      try {
        const user = await userRepository.create({
          email,
          name: wanted.get(email) ?? email,
          password: null,
          status: UserStatus.PENDING_ACTIVATION,
          // Owning the mailbox was proven by the confirmation link.
          emailVerified: true,
          role: { connect: { id: role.id } },
        });
        found.set(email, user);
      } catch (error) {
        // Two approvals racing on the same new email: the loser re-reads the winner's row.
        const again = await userRepository.findByEmail(email);
        if (!again) throw error;
        found.set(email, again);
      }
    }
    return [...found.values()];
  }

  async lookupUsersByEmails(emails: string[]): Promise<UserEntity[]> {
    return userRepository.findManyByEmails(emails);
  }

  /**
   * Fresh single-use activation link for a PENDING_ACTIVATION account; older links are
   * revoked. Returns null when the account is already active — there is nothing to activate,
   * and sending a password link to someone using their account would look like phishing.
   */
  async issueActivationToken(userId: string): Promise<string | null> {
    const user = await userRepository.findById(userId);
    if (!user || user.status !== UserStatus.PENDING_ACTIVATION) {
      return null;
    }

    await authTokenRepository.revokeAllForUser(
      userId,
      AuthTokenType.ACCOUNT_ACTIVATION,
    );

    const plainToken = generateOpaqueToken();
    await authTokenRepository.create({
      userId,
      type: AuthTokenType.ACCOUNT_ACTIVATION,
      tokenHash: hashOpaqueToken(plainToken),
      expiresAt: new Date(Date.now() + ACCOUNT_ACTIVATION_TTL_MS),
    });
    return plainToken;
  }

  activationTtlHours(): number {
    return Math.round(ACCOUNT_ACTIVATION_TTL_MS / 3_600_000);
  }

  /**
   * "Resend activation email" from the login page, so an owner who missed the 72-hour window
   * is never stranded. The caller always answers 200: whether the email has a pending
   * account is not revealed.
   */
  async requestActivationResend(
    rawEmail: string,
  ): Promise<{ email: string; token: string; name: string } | null> {
    const email = rawEmail.trim().toLowerCase();
    const [user] = await userRepository.findManyByEmails([email]);
    if (!user || user.status !== UserStatus.PENDING_ACTIVATION) {
      return null;
    }
    const recent = await authTokenRepository.countCreatedSince(
      user.id,
      AuthTokenType.ACCOUNT_ACTIVATION,
      new Date(Date.now() - 60 * 60 * 1000),
    );
    if (recent >= MAX_ACTIVATION_RESENDS_PER_HOUR) {
      return null;
    }
    const token = await this.issueActivationToken(user.id);
    return token ? { email: user.email, token, name: user.name } : null;
  }

  /**
   * Redeems an activation link: sets the first password and lifts the account out of
   * PENDING_ACTIVATION. Deliberately a link rather than a temporary password — a password
   * mailed in plain text stays readable in that inbox forever.
   */
  async activateAccount(
    plainToken: string,
    newPassword: string,
  ): Promise<boolean> {
    const trimmed = plainToken.trim();
    if (!trimmed) {
      return false;
    }

    const stored = await authTokenRepository.findActiveByHashAndType(
      hashOpaqueToken(trimmed),
      AuthTokenType.ACCOUNT_ACTIVATION,
    );
    if (!stored) {
      return false;
    }

    const user = await userRepository.findById(stored.userId);
    if (!user || user.status !== UserStatus.PENDING_ACTIVATION) {
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
