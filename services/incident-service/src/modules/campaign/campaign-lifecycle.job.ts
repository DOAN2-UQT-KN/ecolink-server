import { campaignLifecycleService } from "./campaign-lifecycle.service";
import { sendRegistrationDigests } from "./campaign_registration/registration-digest";
import { sendShiftReminders } from "./campaign_registration/shift-reminders";
import { sendOverMaxAlerts, sendUnderstaffedAlerts } from "./campaign_registration/staffing-alerts";
import { sendShiftResultReminders } from "./campaign_shift_result/shift-result-reminders";

const INTERVAL_MS = Number(
  process.env.CAMPAIGN_LIFECYCLE_INTERVAL_MS ?? 15 * 60 * 1000,
);

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const started = await campaignLifecycleService.startDueCampaigns();
    if (started > 0) {
      console.log(`[CampaignLifecycle] ${started} upcoming campaign(s) started`);
    }
    const expired = await campaignLifecycleService.expireOverdue();
    if (expired > 0) {
      console.log(`[CampaignLifecycle] ${expired} campaign(s) expired, reports released`);
    }
    const drafts = await campaignLifecycleService.deleteStaleDrafts();
    if (drafts > 0) {
      console.log(`[CampaignLifecycle] ${drafts} untouched draft(s) deleted`);
    }
    const understaffed = await sendUnderstaffedAlerts();
    const overMax = await sendOverMaxAlerts();
    if (understaffed + overMax > 0) {
      console.log(
        `[CampaignLifecycle] staffing alerts: ${understaffed} understaffed day(s), ${overMax} shift(s) over max`,
      );
    }
    const reminders = await sendShiftReminders();
    if (reminders > 0) {
      console.log(`[CampaignLifecycle] ${reminders} shift reminder(s) queued`);
    }
    const resultReminders = await sendShiftResultReminders();
    if (resultReminders > 0) {
      console.log(`[CampaignLifecycle] ${resultReminders} shift(s) reminded of a missing result`);
    }
    const digests = await sendRegistrationDigests();
    if (digests > 0) {
      console.log(`[CampaignLifecycle] registration digest sent for ${digests} campaign(s)`);
    }
  } catch (error) {
    console.error("[CampaignLifecycle] sweep failed", error);
  } finally {
    running = false;
  }
}

/**
 * Sweep that starts upcoming campaigns whose first day began, and expires campaigns that ran
 * out of time before approval: under review or waiting for changes past their start time,
 * waiting for changes past the 7-day deadline, and drafts left untouched for 30 days. After the
 * digest hour it also sends managers the day's registration digest; it also tells managers about
 * shifts short of volunteers 72 h before their day, and shifts over their expected maximum; and
 * reminds volunteers 24 h and 1 h before each day's gathering time, and reminds leaders and
 * managers daily of shifts still waiting for their result 24 h after their end. Every 15 minutes by default, so a campaign expires close to its start.
 */
export function startCampaignLifecycleJob(): void {
  if (process.env.CAMPAIGN_LIFECYCLE_ENABLED === "false") {
    console.log("[CampaignLifecycle] disabled via CAMPAIGN_LIFECYCLE_ENABLED=false");
    return;
  }
  if (timer) return;
  void tick();
  timer = setInterval(() => void tick(), INTERVAL_MS);
}

export function stopCampaignLifecycleJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
