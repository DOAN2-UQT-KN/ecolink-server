import nodemailer from "nodemailer";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  const host = process.env.SMTP_HOST;
  if (!host) {
    return null;
  }

  if (!transporter) {
    const portEnv = process.env.SMTP_PORT;
    const port = portEnv ? Number(portEnv) : 587;
    transporter = nodemailer.createTransport({
      host,
      port: Number.isFinite(port) && port > 0 ? port : 587,
      secure: process.env.SMTP_SECURE === "true",
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASS
          ? {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS,
            }
          : undefined,
    });
  }

  return transporter;
}

export class EmailProvider {
  async send(params: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<{ sent: boolean; skippedReason?: string }> {
    const from =
      process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@localhost";
    const tx = getTransporter();

    if (!tx) {
      console.warn(
        "[notification-service] SMTP_HOST not set; email not sent (record still stored)",
      );
      return { sent: false, skippedReason: "smtp_not_configured" };
    }

    await tx.sendMail({
      from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
    });

    return { sent: true };
  }
}

export const emailProvider = new EmailProvider();
