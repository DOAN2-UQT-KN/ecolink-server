import bcrypt from "bcryptjs";
import { userRepository } from "../user/user.repository";
import { roleRepository } from "../role/role.repository";
import { generateTokens, verifyToken } from "../../utils/jwt.utils";
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

    // Generate tokens
    const tokens = generateTokens({
      userId: user.id,
      email: user.email,
      role: user.roleId,
    });

    // TODO: Store refreshToken in Redis instead of DB

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

      const user = await userRepository.findById(decoded.userId);
      if (!user) {
        return null;
      }

      // TODO: Validate refreshToken against Redis

      const tokens = generateTokens({
        userId: user.id,
        email: user.email,
        role: user.roleId,
      });
      
      // TODO: Store new refreshToken in Redis, invalidate old one

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

    return true;
  }

  async requestPasswordReset(
    request: RequestPasswordResetRequest,
  ): Promise<string | null> {
    const user = await userRepository.findByEmail(request.email);
    if (!user) {
      return null;
    }

    const resetToken =
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15);

    // TODO: Store resetToken in Redis with 1 hour TTL
    // await redisClient.set(`reset:${resetToken}`, user.id, 'EX', 3600);

    return resetToken;
  }

  async resetPassword(_request: ResetPasswordRequest): Promise<boolean> {
    // TODO: Look up resetToken in Redis to get userId
    // const userId = await redisClient.get(`reset:${request.resetToken}`);
    // if (!userId) return false;
    // const user = await userRepository.findById(userId);

    // Placeholder until Redis is set up — this won't work without Redis
    console.warn("resetPassword requires Redis implementation");
    return false;
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
    // TODO: Invalidate refreshToken in Redis
    // await redisClient.del(`refresh:${userId}`);

    const user = await userRepository.findById(userId);
    if (!user) {
      return;
    }
  }
}

// Singleton instance
export const authService = new AuthService();
