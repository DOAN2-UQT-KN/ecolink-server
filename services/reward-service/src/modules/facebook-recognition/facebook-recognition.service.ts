import crypto from "crypto";
import { backgroundJobDispatcher } from "../../queue/green-point-queue.bootstrap";
import {
  FACEBOOK_RECOGNITION_JOB_TYPE,
  type CampaignFacebookRecognitionPayload,
  type RecognizedVolunteerContact,
} from "./facebook-recognition.types";

export class FacebookRecognitionService {
  private validatePayload(payload: unknown): CampaignFacebookRecognitionPayload {
    if (!payload || typeof payload !== "object") {
      throw new Error("Facebook recognition payload must be an object");
    }
    const p = payload as Record<string, unknown>;
    if (typeof p.campaignId !== "string" || !p.campaignId.trim()) {
      throw new Error("campaignId is required");
    }
    if (typeof p.campaignTitle !== "string" || !p.campaignTitle.trim()) {
      throw new Error("campaignTitle is required");
    }
    if (!Array.isArray(p.recognizedUserIds)) {
      throw new Error("recognizedUserIds must be an array");
    }
    const recognizedUserIds: string[] = [];
    for (const uid of p.recognizedUserIds) {
      if (typeof uid !== "string" || !uid.trim()) {
        throw new Error("recognizedUserIds must contain non-empty strings");
      }
      recognizedUserIds.push(uid.trim());
    }
    if (typeof p.completedAt !== "string" || !p.completedAt.trim()) {
      throw new Error("completedAt is required");
    }

    let bannerUrl: string | null = null;
    if (p.bannerUrl !== undefined && p.bannerUrl !== null) {
      if (typeof p.bannerUrl !== "string") {
        throw new Error("bannerUrl must be a string when provided");
      }
      const b = p.bannerUrl.trim();
      if (b.length > 2048) {
        throw new Error("bannerUrl is too long");
      }
      bannerUrl = b.length ? b : null;
    }

    let description: string | null = null;
    if (p.description !== undefined && p.description !== null) {
      if (typeof p.description !== "string") {
        throw new Error("description must be a string when provided");
      }
      const d = p.description.trim();
      description = d.length ? d : null;
    }

    let recognizedVolunteers: RecognizedVolunteerContact[] | undefined;
    if (p.recognizedVolunteers !== undefined && p.recognizedVolunteers !== null) {
      if (!Array.isArray(p.recognizedVolunteers)) {
        throw new Error("recognizedVolunteers must be an array when provided");
      }
      const vols: RecognizedVolunteerContact[] = [];
      for (const item of p.recognizedVolunteers.slice(0, 80)) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error("recognizedVolunteers entries must be objects");
        }
        const o = item as Record<string, unknown>;
        if (typeof o.name !== "string" || !o.name.trim()) {
          throw new Error("recognizedVolunteers.name is required");
        }
        const name = o.name.trim();
        if (name.length > 120) {
          throw new Error("recognizedVolunteers.name is too long");
        }
        let email: string | null = null;
        if (o.email !== undefined && o.email !== null) {
          if (typeof o.email !== "string") {
            throw new Error("recognizedVolunteers.email must be a string when provided");
          }
          const e = o.email.trim().toLowerCase();
          email = e.length > 0 ? e : null;
        }
        vols.push({ name, email });
      }
      recognizedVolunteers = vols.length ? vols : undefined;
    }

    return {
      campaignId: p.campaignId.trim(),
      campaignTitle: p.campaignTitle.trim(),
      recognizedUserIds,
      completedAt: p.completedAt.trim(),
      bannerUrl,
      description,
      recognizedVolunteers,
    };
  }

  private async fetchOk(url: string, init: RequestInit): Promise<Response> {
    const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return res;
  }

  async enqueue(payload: CampaignFacebookRecognitionPayload): Promise<void> {
    this.validatePayload(payload);
    await backgroundJobDispatcher.enqueue(FACEBOOK_RECOGNITION_JOB_TYPE, payload);
  }

  private buildFacebookMessage(p: CampaignFacebookRecognitionPayload): string {
    const list = (p.recognizedVolunteers ?? []).map((v) => v.name);
    const namesSnippet = list.length > 0 ? list.slice(0, 12).join(", ") : "";
    const honor =
      namesSnippet.length > 0
        ? ` Cảm ơn các bạn: ${namesSnippet}${list.length > 12 ? " và các tình nguyện viên khác" : ""}.`
        : "";
    return `Chiến dịch "${p.campaignTitle}" đã hoàn thành. Xin trân trọng cảm ơn ${p.recognizedUserIds.length} tình nguyện viên đã đồng hành.${honor} (${p.completedAt})`;
  }

  private isHttpsUrl(u: string | null | undefined): u is string {
    if (!u || typeof u !== "string") return false;
    try {
      return new URL(u.trim()).protocol === "https:";
    } catch {
      return false;
    }
  }

  private async fetchCaptionFromAi(
    p: CampaignFacebookRecognitionPayload,
  ): Promise<string> {
    const base = (process.env.AI_SERVICE_URL || "http://localhost:3004").replace(/\/$/, "");
    const url = `${base}/api/v1/social/campaign-facebook-caption`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaignTitle: p.campaignTitle,
        volunteerCount: p.recognizedUserIds.length,
        completedAt: p.completedAt,
        bannerUrl: p.bannerUrl ?? undefined,
        description: p.description ?? undefined,
        volunteers: (p.recognizedVolunteers ?? []).map((v) => ({
          name: v.name,
          email: v.email ?? undefined,
        })),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI caption HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { caption?: string };
    const caption = typeof data.caption === "string" ? data.caption.trim() : "";
    if (!caption) {
      throw new Error("AI caption response missing caption");
    }
    return caption.length > 5000 ? caption.slice(0, 5000) : caption;
  }

  private appSecretProof(accessToken: string, appSecret: string): string {
    return crypto.createHmac("sha256", appSecret).update(accessToken).digest("hex");
  }

  private graphParams(
    token: string,
    appId: string | undefined,
    appSecret: string | undefined,
  ): URLSearchParams {
    const params = new URLSearchParams({ access_token: token });
    if (appId && appSecret) {
      params.set("appsecret_proof", this.appSecretProof(token, appSecret));
    }
    return params;
  }

  private async postToFacebookGraph(
    p: CampaignFacebookRecognitionPayload,
    caption: string,
  ): Promise<void> {
    const token = process.env.FACEBOOK_ACCESS_TOKEN?.trim();
    if (!token) return;

    const version = (process.env.FACEBOOK_GRAPH_API_VERSION || "v21.0").replace(/^\/+/, "");
    const objectId = (process.env.FACEBOOK_FEED_OBJECT_ID || "me").trim() || "me";
    const appId = process.env.FACEBOOK_APP_ID?.trim();
    const appSecret = process.env.FACEBOOK_APP_SECRET?.trim();

    const banner = p.bannerUrl?.trim();
    if (this.isHttpsUrl(banner)) {
      const photoUrl = `https://graph.facebook.com/${version}/${objectId}/photos`;
      const body = this.graphParams(token, appId, appSecret);
      body.set("url", banner);
      body.set("caption", caption);
      body.set("published", "true");
      try {
        await this.fetchOk(photoUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        return;
      } catch (e) {
        console.warn(
          "[reward-service] Facebook photo post failed, falling back to text feed",
          e instanceof Error ? e.message : e,
        );
      }
    }

    const feedUrl = `https://graph.facebook.com/${version}/${objectId}/feed`;
    const feedBody = this.graphParams(token, appId, appSecret);
    feedBody.set("message", caption);
    await this.fetchOk(feedUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: feedBody,
    });
  }

  async applyQueuedJob(payload: unknown): Promise<void> {
    const p = this.validatePayload(payload);
    const webhook = process.env.FACEBOOK_RECOGNITION_WEBHOOK_URL?.trim();
    const hasGraphToken = Boolean(process.env.FACEBOOK_ACCESS_TOKEN?.trim());

    let captionForFacebook: string | null = null;
    if (hasGraphToken || webhook) {
      try {
        captionForFacebook = await this.fetchCaptionFromAi(p);
      } catch (e) {
        console.warn(
          "[reward-service] AI Facebook caption failed, using fallback text",
          e instanceof Error ? e.message : e,
        );
        captionForFacebook = this.buildFacebookMessage(p);
      }
    }

    if (hasGraphToken && captionForFacebook) {
      await this.postToFacebookGraph(p, captionForFacebook);
    }

    if (webhook) {
      await this.fetchOk(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: FACEBOOK_RECOGNITION_JOB_TYPE,
          payload: p,
          ...(captionForFacebook ? { generatedCaption: captionForFacebook } : {}),
        }),
      });
    }

    if (!hasGraphToken && !webhook) {
      console.log("[reward-service] Facebook recognition queued (no FACEBOOK_ACCESS_TOKEN or webhook)", {
        campaignId: p.campaignId,
        campaignTitle: p.campaignTitle,
        recognizedCount: p.recognizedUserIds.length,
        completedAt: p.completedAt,
      });
    }
  }
}

export const facebookRecognitionService = new FacebookRecognitionService();
