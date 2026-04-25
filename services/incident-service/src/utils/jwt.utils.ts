import jwt from "jsonwebtoken";

const JWT_SECRET = (process.env.JWT_SECRET ?? "").trim();
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not set");
}

export interface TokenPayload {
  userId: string;
  email: string;
  role?: string;
}

/**
 * Verify and decode JWT token
 */
export const verifyToken = (token: string): TokenPayload => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload;
    return decoded;
  } catch (error) {
    throw new Error("Invalid or expired token");
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
