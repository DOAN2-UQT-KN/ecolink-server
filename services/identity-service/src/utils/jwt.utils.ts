import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import type { StringValue } from 'ms';

const JWT_SECRET: Secret = (process.env.JWT_SECRET ?? "").trim();
if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is not set");
}
const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN || '30m') as StringValue;
const JWT_REFRESH_EXPIRES_IN = (process.env.JWT_REFRESH_EXPIRES_IN || '30d') as StringValue;

export interface TokenPayload {
    userId: string;
    email: string;
    role?: string;
}

export interface TokenPair {
    accessToken: string;
    refreshToken: string;
}

/**
 * Generate access and refresh tokens
 */
export const generateTokens = (payload: TokenPayload): TokenPair => {
    const accessTokenOptions: SignOptions = {
        expiresIn: JWT_EXPIRES_IN,
    };

    const refreshTokenOptions: SignOptions = {
        expiresIn: JWT_REFRESH_EXPIRES_IN,
    };

    const accessToken = jwt.sign(payload, JWT_SECRET, accessTokenOptions);
    const refreshToken = jwt.sign(payload, JWT_SECRET, refreshTokenOptions);

    return { accessToken, refreshToken };
};

/**
 * Verify and decode JWT token
 */
export const verifyToken = (token: string): TokenPayload => {
    try {
        const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload;
        return decoded;
    } catch (error) {
        throw new Error('Invalid or expired token');
    }
};

/**
 * Decode token without verification (for expired token inspection)
 */
export const decodeToken = (token: string): TokenPayload | null => {
    try {
        return jwt.decode(token) as TokenPayload;
    } catch (error) {
        return null;
    }
};

/** Expiry from a signed JWT (`exp` claim), or null if missing. */
export const getJwtExpiresAt = (token: string): Date | null => {
    const decoded = jwt.decode(token) as { exp?: number } | null;
    if (decoded?.exp == null || typeof decoded.exp !== "number") {
        return null;
    }
    return new Date(decoded.exp * 1000);
};
