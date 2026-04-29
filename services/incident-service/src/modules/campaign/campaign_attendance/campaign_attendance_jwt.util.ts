import jwt from "jsonwebtoken";

const JWT_SECRET = (process.env.JWT_SECRET ?? "").trim();

export const CAMPAIGN_ATTENDANCE_QR_PURPOSE = "campaign_attendance_qr_v1";

/** QR link validity (seconds). */
export const CAMPAIGN_ATTENDANCE_QR_TTL_SEC = 3600;

export function signCampaignAttendanceQrToken(campaignId: string): {
  token: string;
  expiresAt: Date;
} {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is not set");
  }
  const expiresAt = new Date(
    Date.now() + CAMPAIGN_ATTENDANCE_QR_TTL_SEC * 1000,
  );
  const token = jwt.sign(
    { purpose: CAMPAIGN_ATTENDANCE_QR_PURPOSE, campaignId },
    JWT_SECRET,
    { expiresIn: CAMPAIGN_ATTENDANCE_QR_TTL_SEC },
  );
  return { token, expiresAt };
}

/** Returns campaignId embedded in the token, or throws. */
export function verifyCampaignAttendanceQrToken(token: string): string {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is not set");
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload & {
      purpose?: string;
      campaignId?: string;
    };
    if (
      decoded.purpose !== CAMPAIGN_ATTENDANCE_QR_PURPOSE ||
      typeof decoded.campaignId !== "string" ||
      !decoded.campaignId
    ) {
      throw new Error("invalid payload");
    }
    return decoded.campaignId;
  } catch {
    throw new Error("Invalid or expired QR token");
  }
}
