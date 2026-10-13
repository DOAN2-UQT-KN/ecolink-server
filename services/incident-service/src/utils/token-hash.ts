import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";

/** sha256 hex — fits the VARCHAR(64) columns that hold token/OTP digests. */
export const hashOpaqueToken = (plainToken: string): string =>
  createHash("sha256").update(plainToken, "utf8").digest("hex");

/** Cryptographically strong opaque token (store only `hashOpaqueToken` in the database). */
export const generateOpaqueToken = (): string =>
  randomBytes(32).toString("base64url");

/** Zero-padded 6-digit code, drawn from a CSPRNG (not `Math.random`). */
export const generateNumericOtp = (digits = 6): string => {
  const max = 10 ** digits;
  return String(randomInt(0, max)).padStart(digits, "0");
};

/** Constant-time comparison of two hex digests of equal length. */
export const digestsMatch = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
};
