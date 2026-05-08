type TranslationResult = {
  detected_language: "vi" | "en";
  vn: string;
  en: string;
};

/**
 * Calls the ai-service service-to-service translation route. Uses the shared
 * `INTERNAL_AI_API_KEY` so background workers can translate without needing a
 * per-user JWT.
 *
 * On any failure (missing config, non-2xx, network) the function falls back
 * to returning the source text in both languages so callers (e.g. the
 * translation worker) can still write something to the row.
 */
export async function translateText(
  text: string,
): Promise<{ vi: string; en: string }> {
  const trimmed = text.trim();
  if (!trimmed) return { vi: "", en: "" };

  const base = (process.env.AI_SERVICE_URL || "http://localhost:3004").replace(
    /\/$/,
    "",
  );
  const apiKey = (process.env.INTERNAL_AI_API_KEY ?? "").trim();
  if (!apiKey) {
    console.warn(
      "[reward-service] INTERNAL_AI_API_KEY is not set; skipping translation",
    );
    return { vi: trimmed, en: trimmed };
  }

  try {
    const res = await fetch(`${base}/internal/v1/translate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-api-key": apiKey,
      },
      body: JSON.stringify({ content: trimmed }),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      console.warn(
        `[reward-service] translateText HTTP ${res.status} from ai-service: ${bodyText.slice(0, 500)}`,
      );
      return { vi: trimmed, en: trimmed };
    }
    const data = (await res.json()) as TranslationResult;
    return { vi: data.vn ?? "", en: data.en ?? "" };
  } catch (err) {
    console.warn(
      `[reward-service] translateText network/parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { vi: trimmed, en: trimmed };
  }
}
