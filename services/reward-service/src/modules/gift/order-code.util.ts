import { randomInt } from "crypto";

/** No 0 O 1 I L, so a code read out over the phone is not misheard (spec 017 FR-001). */
export const ORDER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const ORDER_CODE_PATTERN = /^EL-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

/** "EL-" + 8 random characters; 31^8 codes, a clash is retried by the caller. */
export function generateOrderCode(): string {
  let code = "EL-";
  for (let i = 0; i < 8; i++) {
    code += ORDER_CODE_ALPHABET[randomInt(ORDER_CODE_ALPHABET.length)];
  }
  return code;
}

/** Accepts any case, spaces and a missing "EL-"; null when it cannot be an order code. */
export function normalizeOrderCode(input: string): string | null {
  const compact = input.replace(/\s+/g, "").toUpperCase();
  const code = compact.startsWith("EL-") ? compact : `EL-${compact}`;
  return ORDER_CODE_PATTERN.test(code) ? code : null;
}
