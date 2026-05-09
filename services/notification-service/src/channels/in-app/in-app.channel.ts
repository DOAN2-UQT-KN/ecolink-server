import { NotificationType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { notificationTemplateEngine } from "../../modules/templates/notification-template.engine";
import type {
  ChannelDeliveryResult,
  NotificationChannelStrategy,
} from "../notification-channel.strategy";
import type { SendNotificationJobPayload } from "../../queue/notification-job.types";

class InAppNotificationChannel implements NotificationChannelStrategy {
  readonly prismaType = NotificationType.WEBSITE;

  supports(apiType: string): boolean {
    const n = apiType.toLowerCase();
    return n === "website" || n === "in-app" || n === "inapp";
  }

  async deliver(
    job: SendNotificationJobPayload,
    normalizedPayload: Record<string, string>,
  ): Promise<ChannelDeliveryResult> {
    if (!job.userId) {
      throw new Error("userId is required for website / in-app notifications");
    }

    const bilingual = notificationTemplateEngine.renderWebsiteTemplatesBilingual(
      job.kind,
      normalizedPayload,
    );

    const payloadWithLocales: Record<string, unknown> = {
      ...normalizedPayload,
      locales: {
        en: { title: bilingual.en.title, body: bilingual.en.body },
        vi: { title: bilingual.vi.title, body: bilingual.vi.body },
      },
    };

    const notification = await prisma.notification.create({
      data: {
        userId: job.userId,
        type: NotificationType.WEBSITE,
        kind: job.kind,
        title: bilingual.en.title,
        body: bilingual.en.body,
        htmlBody: null,
        payload: payloadWithLocales as object,
        readAt: null,
      },
    });

    return { notification };
  }
}

export const inAppNotificationChannel = new InAppNotificationChannel();
