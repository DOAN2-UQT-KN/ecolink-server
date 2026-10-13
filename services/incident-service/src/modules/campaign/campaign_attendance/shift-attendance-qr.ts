import jwt from "jsonwebtoken";
import { CAMPAIGN_ATTENDANCE_QR_PERIOD_SEC } from "@da2/constants";
import { HttpError, HTTP_STATUS } from "../../../constants/http-status";

const PURPOSE = "shift_attendance_qr_v2";
/** Clock difference tolerated between the server and the moment a scan claims. */
const SKEW_MS = 5_000;

export interface ShiftQrClaims {
  campaignId: string;
  shiftId: string;
  sessionId: string;
  /** When the code was made, in ms. */
  ts: number;
}

function secret(): string {
  const value = (process.env.JWT_SECRET ?? "").trim();
  if (!value) throw new Error("JWT_SECRET is not set");
  return value;
}

/**
 * A dynamic QR code (spec 4.1): a server-signed JWT naming the campaign, the shift, the session
 * and the moment it was made. The leader's screen fetches a new one every period.
 */
export function signShiftQr(claims: Omit<ShiftQrClaims, "ts">, now = new Date()): string {
  return jwt.sign({ purpose: PURPOSE, ...claims, ts: now.getTime() }, secret());
}

/**
 * Checks the signature, and that the code was made in the period of `scannedAt` or the one
 * before (network delay). Throws 422 ATTENDANCE_QR_INVALID otherwise.
 */
export function verifyShiftQr(token: string, scannedAt: Date): ShiftQrClaims {
  let decoded: jwt.JwtPayload & Partial<ShiftQrClaims> & { purpose?: string };
  try {
    decoded = jwt.verify(token, secret()) as typeof decoded;
  } catch {
    throw new HttpError(HTTP_STATUS.ATTENDANCE_QR_INVALID);
  }
  const { campaignId, shiftId, sessionId, ts } = decoded;
  if (
    decoded.purpose !== PURPOSE ||
    typeof campaignId !== "string" ||
    typeof shiftId !== "string" ||
    typeof sessionId !== "string" ||
    typeof ts !== "number"
  ) {
    throw new HttpError(HTTP_STATUS.ATTENDANCE_QR_INVALID);
  }
  const age = scannedAt.getTime() - ts;
  if (age < -SKEW_MS || age > 2 * CAMPAIGN_ATTENDANCE_QR_PERIOD_SEC * 1000) {
    throw new HttpError(HTTP_STATUS.ATTENDANCE_QR_INVALID);
  }
  return { campaignId, shiftId, sessionId, ts };
}
