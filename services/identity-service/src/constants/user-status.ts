/** User account status (matches GlobalStatus ACTIVE/INACTIVE used elsewhere). */
export const UserStatus = {
  ACTIVE: 1,
  INACTIVE: 2,
  /**
   * Account created for an approved organization owner who had no Ecolink account yet. It
   * has no password until the activation link is redeemed and must never be able to log in.
   */
  PENDING_ACTIVATION: 3,
} as const;

export type UserStatusValue = (typeof UserStatus)[keyof typeof UserStatus];
