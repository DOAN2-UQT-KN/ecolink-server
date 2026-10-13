import { ownerConfirmationService } from "./owner-confirmation.service";
import { organizationInvitationService } from "../organization/organization-invitation.service";
import { ownerChangeExecutor } from "./owner-change-executor";

const INTERVAL_MS = Number(
  process.env.OWNER_CONFIRMATION_EXPIRY_INTERVAL_MS ?? 60 * 60 * 1000,
);

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const expired = await ownerConfirmationService.expireOverdue();
    if (expired > 0) {
      console.log(
        `[OwnerConfirmationExpiry] ${expired} application(s) sent back or cancelled`,
      );
    }
    const changes = await ownerChangeExecutor.sweep();
    if (changes.expired + changes.applied > 0) {
      console.log(
        `[OwnerConfirmationExpiry] owner changes: ${changes.expired} cancelled (approval overdue), ${changes.applied} applied on retry`,
      );
    }
    const invitations = await organizationInvitationService.expireOverdue();
    if (invitations > 0) {
      console.log(`[OwnerConfirmationExpiry] ${invitations} invitation(s) expired`);
    }
  } catch (error) {
    console.error("[OwnerConfirmationExpiry] sweep failed", error);
  } finally {
    running = false;
  }
}

/**
 * Hourly sweep for owner confirmations and co-owner approvals that ran past their 14 days,
 * expired member invitations, and owner changes whose application failed on a transient
 * error. Moving an application forward never waits on this — that happens right after the
 * last answer — but an unanswered link needs a clock.
 */
export function startOwnerConfirmationExpiryJob(): void {
  if (process.env.OWNER_CONFIRMATION_EXPIRY_ENABLED === "false") {
    console.log("[OwnerConfirmationExpiry] disabled via OWNER_CONFIRMATION_EXPIRY_ENABLED=false");
    return;
  }
  if (timer) return;
  void tick();
  timer = setInterval(() => void tick(), INTERVAL_MS);
}

export function stopOwnerConfirmationExpiryJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
