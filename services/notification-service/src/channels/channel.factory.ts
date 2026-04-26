import type { NotificationChannelStrategy } from "./notification-channel.strategy";
import { emailNotificationChannel } from "./email/email.channel";
import { inAppNotificationChannel } from "./in-app/in-app.channel";

const channels: NotificationChannelStrategy[] = [
  emailNotificationChannel,
  inAppNotificationChannel,
];

export function getChannel(apiType: string): NotificationChannelStrategy {
  const channel = channels.find((c) => c.supports(apiType));
  if (!channel) {
    throw new Error(
      `Unsupported notification channel "${apiType}"; expected one of: email, website`,
    );
  }
  return channel;
}
