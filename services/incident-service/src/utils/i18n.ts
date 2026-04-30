export type SupportedLanguage = "vi" | "en";

export function normalizeLanguage(input?: string | null): SupportedLanguage {
  const raw = (input ?? "").toLowerCase().trim();
  if (raw.startsWith("en")) return "en";
  return "vi";
}

export function parseLanguageFromRequest(req: {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}): SupportedLanguage {
  const queryLang =
    typeof req.query?.lang === "string" ? req.query.lang : undefined;
  if (queryLang) return normalizeLanguage(queryLang);
  const header = req.headers?.["accept-language"];
  if (typeof header === "string") return normalizeLanguage(header);
  return "vi";
}

export function pickLocalizedText(
  lang: SupportedLanguage,
  vi?: string | null,
  en?: string | null,
): string | null {
  const v = vi?.trim() || null;
  const e = en?.trim() || null;
  if (lang === "en") return e ?? v;
  return v ?? e;
}
