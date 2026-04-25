import crypto from "crypto";
import { AuthTokenType } from "../../constants/auth-token-type";
import { hashOpaqueToken } from "../../utils/token-hash";
import { generateTokens, getJwtExpiresAt } from "../../utils/jwt.utils";
import { authTokenRepository } from "../auth/auth_token.repository";
import { LoginResponse } from "../auth/auth.dto";
import { roleRepository } from "../role/role.repository";
import { userRepository } from "../user/user.repository";
import {
  GoogleOauthClient,
  GoogleTokenResponse,
} from "./google-oauth.client";
import { GoogleOauthClientFactory } from "./google-oauth.client.factory";
import { OAuthService } from "./oauth.service";

export class GoogleOauthService
  implements OAuthService<GoogleTokenResponse, LoginResponse>
{
  constructor(private readonly googleOauthClient: GoogleOauthClient) {}

  getAuthorizationUrl(state?: string): string {
    return this.googleOauthClient.getAuthorizationUrl(state);
  }

  exchangeToken(code: string): Promise<GoogleTokenResponse> {
    return this.googleOauthClient.exchangeToken(code);
  }

  async handleCallback(code: string, _state?: string): Promise<LoginResponse> {
    const tokenResult = await this.exchangeToken(code);
    const profile = await this.googleOauthClient.getUserInfo(
      tokenResult.access_token,
    );

    if (!profile.email) {
      throw new Error("Google account email is required");
    }

    const email = profile.email.trim().toLowerCase();
    const fallbackName = email.split("@")[0];
    let user = await userRepository.findByEmail(email);

    if (!user) {
      const defaultRole = await roleRepository.findRoleByName("USER");
      if (!defaultRole) {
        throw new Error("Default USER role not found");
      }

      const syntheticPassword = crypto.randomUUID();
      user = await userRepository.create({
        email,
        name: profile.name?.trim() || fallbackName,
        password: syntheticPassword,
        avatar: profile.picture ?? null,
        bio: null,
        roleId: defaultRole.id,
        emailVerified: Boolean(profile.verified_email),
        verificationToken: null,
      });
    } else if (!user.emailVerified && profile.verified_email) {
      user = await userRepository.update(user.id, { emailVerified: true });
    }

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
}

const googleOauthClient = GoogleOauthClientFactory.create();
export const googleOauthService = new GoogleOauthService(googleOauthClient);
