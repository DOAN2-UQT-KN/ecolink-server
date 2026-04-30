export type SupportedLanguage = "vi" | "en";

export function normalizeLanguage(input?: string | null): SupportedLanguage {
  const raw = (input ?? "").toLowerCase().trim();
  if (raw.startsWith("en")) return "en";
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
