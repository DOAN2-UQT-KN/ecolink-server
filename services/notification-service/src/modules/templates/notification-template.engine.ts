import fs from "fs";
import path from "path";
import Handlebars from "handlebars";
import { NotificationKind, NotificationType } from "@prisma/client";

const compiled = new Map<string, Handlebars.TemplateDelegate>();

function templatesRoot(): string {
  return path.join(process.cwd(), "templates", "notifications");
}

function kindDir(kind: NotificationKind): string {
  return path.join(templatesRoot(), kind);
}

function firstExistingPath(candidates: string[]): string | null {
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

function compileFile(fullPath: string, cacheKey: string): Handlebars.TemplateDelegate {
  const cached = compiled.get(cacheKey);
  if (cached) {
    return cached;
  }

  const source = fs.readFileSync(fullPath, "utf8");
  const tpl = Handlebars.compile(source, { strict: false });
  compiled.set(cacheKey, tpl);
  return tpl;
}

export type NotificationLocale = "en" | "vi";

function resolveWebsiteTemplatePath(
  kind: NotificationKind,
  part: "title" | "body",
  locale: NotificationLocale,
): string {
  const dir = kindDir(kind);
  const base = `website.${part}`;
  const candidates =
    locale === "vi"
      ? [`${base}.vi.hbs`, `${base}.en.hbs`, `${base}.hbs`]
      : [`${base}.en.hbs`, `${base}.hbs`];
  const found = firstExistingPath(candidates.map((c) => path.join(dir, c)));
  if (!found) {
    throw new Error(
      `Missing website template for ${kind} ${base} (locale ${locale})`,
    );
  }
  return found;
}

function resolveEmailTemplatePath(
  kind: NotificationKind,
  file: "email.subject" | "email.text" | "email.html",
  locale: NotificationLocale,
): string {
  const dir = kindDir(kind);
  const base = file;
  const candidates =
    locale === "vi"
      ? [`${base}.vi.hbs`, `${base}.en.hbs`, `${base}.hbs`]
      : [`${base}.en.hbs`, `${base}.hbs`];
  const found = firstExistingPath(candidates.map((c) => path.join(dir, c)));
  if (!found) {
    throw new Error(
      `Missing email template for ${kind} ${file} (locale ${locale})`,
    );
  }
  return found;
}

export interface RenderedEmailParts {
  subject: string;
  text: string;
  html: string;
}

export interface RenderedWebsiteParts {
  title: string;
  body: string;
}

export class NotificationTemplateEngine {
  renderWebsiteTemplates(
    kind: NotificationKind,
    data: Record<string, string>,
    locale: NotificationLocale,
  ): RenderedWebsiteParts {
    const titlePath = resolveWebsiteTemplatePath(kind, "title", locale);
    const bodyPath = resolveWebsiteTemplatePath(kind, "body", locale);
    const titleTpl = compileFile(titlePath, `${titlePath}|tpl`);
    const bodyTpl = compileFile(bodyPath, `${bodyPath}|tpl`);
    return {
      title: titleTpl(data),
      body: bodyTpl(data),
    };
  }

  renderWebsiteTemplatesBilingual(
    kind: NotificationKind,
    data: Record<string, string>,
  ): { en: RenderedWebsiteParts; vi: RenderedWebsiteParts } {
    return {
      en: this.renderWebsiteTemplates(kind, data, "en"),
      vi: this.renderWebsiteTemplates(kind, data, "vi"),
    };
  }

  renderEmailTemplates(
    kind: NotificationKind,
    data: Record<string, string>,
    locale: NotificationLocale = "en",
  ): RenderedEmailParts {
    const subjectPath = resolveEmailTemplatePath(kind, "email.subject", locale);
    const textPath = resolveEmailTemplatePath(kind, "email.text", locale);
    const htmlPath = resolveEmailTemplatePath(kind, "email.html", locale);
    return {
      subject: compileFile(subjectPath, `${subjectPath}|tpl`)(data),
      text: compileFile(textPath, `${textPath}|tpl`)(data),
      html: compileFile(htmlPath, `${htmlPath}|tpl`)(data),
    };
  }

  renderForDelivery(
    kind: NotificationKind,
    type: NotificationType,
    data: Record<string, string>,
    locale: NotificationLocale = "en",
  ): {
    title: string;
    body: string;
    htmlBody?: string;
    emailSubject?: string;
  } {
    if (type === NotificationType.EMAIL) {
      const e = this.renderEmailTemplates(kind, data, locale);
      return {
        title: e.subject,
        body: e.text,
        htmlBody: e.html,
        emailSubject: e.subject,
      };
    }

    const w = this.renderWebsiteTemplates(kind, data, locale);
    return {
      title: w.title,
      body: w.body,
    };
  }
}

export const notificationTemplateEngine = new NotificationTemplateEngine();
