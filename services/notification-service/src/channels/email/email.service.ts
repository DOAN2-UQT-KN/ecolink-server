import {
  EmailProvider,
  emailProvider as defaultProvider,
} from "./email.provider";

export class EmailService {
  constructor(private readonly provider: EmailProvider = defaultProvider) {}

  async sendNotificationMail(params: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<{ sent: boolean; skippedReason?: string }> {
    return this.provider.send(params);
  }
}

export const emailService = new EmailService();
