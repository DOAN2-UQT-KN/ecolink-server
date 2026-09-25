/** User account status (matches GlobalStatus ACTIVE/INACTIVE used elsewhere). */
export const UserStatus = {
  ACTIVE: 1,
  INACTIVE: 2,
  /**
   * Provisioned organization account that has not set a password yet. It exists so the
   * activation link has something to attach to; it must never be able to log in.
   */
  PENDING_ACTIVATION: 3,
} as const;

export type UserStatusValue = (typeof UserStatus)[keyof typeof UserStatus];

/** Account kinds. An organization is operated through exactly one `ORG` login. */
export const AccountType = {
  PERSONAL: "PERSONAL",
  ORG: "ORG",
} as const;

export type AccountTypeValue = (typeof AccountType)[keyof typeof AccountType];
