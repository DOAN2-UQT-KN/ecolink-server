// Auth Request DTOs
export interface SignupRequest {
  email: string;
  password: string;
  name: string;
  roleId?: string; // Optional, defaults to a 'user' role
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export interface UpdatePasswordRequest {
  userId: string;
  oldPassword: string;
  newPassword: string;
}

/** Body sent to POST /auth/update-password (userId comes from the JWT). */
export interface AuthUpdatePasswordBody {
  oldPassword: string;
  newPassword: string;
}

/** Optional body; refresh token may also be sent via httpOnly cookie. */
export interface RefreshTokenBody {
  refreshToken?: string;
}

export interface RequestPasswordResetRequest {
  email: string;
}

export interface ResetPasswordRequest {
  resetToken: string;
  newPassword: string;
}

export interface GoogleOauthCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}

// Auth Response DTOs
export interface SignupResponse {
  id: string;
  email: string;
  name: string;
  roleId: string;
  avatar: string | null;
  bio: string | null;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface LoginResponse {
  user: {
    id: string;
    email: string;
    name: string;
    roleId: string;
    avatar: string | null;
    bio: string | null;
  };
  accessToken: string;
  refreshToken: string;
}

export interface RefreshTokenResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    roleId: string;
  };
}

export interface CurrentUserResponse {
  id: string;
  email: string;
  name: string;
  roleId: string;
  avatar: string | null;
  bio: string | null;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}
