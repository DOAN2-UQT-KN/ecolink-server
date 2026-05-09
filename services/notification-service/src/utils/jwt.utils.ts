import jwt, { Secret } from "jsonwebtoken";

/** Must match identity-service `JWT_SECRET` exactly (same signing key for Bearer tokens). */
const JWT_SECRET: Secret = (process.env.JWT_SECRET ?? "").trim();
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not set");
}

export interface TokenPayload {
  userId: string;
  email: string;
  role?: string;
}

export const verifyToken = (token: string): TokenPayload => {
  const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload;
  return decoded;
};
