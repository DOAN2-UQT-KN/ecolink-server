import { campaignLifecycleService } from "./campaign-lifecycle.service";

const INTERVAL_MS = Number(
  process.env.CAMPAIGN_LIFECYCLE_INTERVAL_MS ?? 15 * 60 * 1000,
);

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const expired = await campaignLifecycleService.expireOverdue();
    if (expired > 0) {
      console.log(`[CampaignLifecycle] ${expired} campaign(s) expired, reports released`);
    }
    const drafts = await campaignLifecycleService.deleteStaleDrafts();
    if (drafts > 0) {
      console.log(`[CampaignLifecycle] ${drafts} untouched draft(s) deleted`);
    }
  } catch (error) {
    console.error("[CampaignLifecycle] sweep failed", error);
  } finally {
    running = false;
  }
}

/**
 * Sweep for campaigns that ran out of time before approval: under review or waiting for
 * changes past their start time, waiting for changes past the 7-day deadline, and drafts left
 * untouched for 30 days. Every 15 minutes by default, so a campaign expires close to its start.
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
