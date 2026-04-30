type TranslationResult = {
  detected_language: "vi" | "en";
  vn: string;
  en: string;
};

export async function translateText(
  text: string,
  authorization?: string,
): Promise<{ vi: string; en: string }> {
  const trimmed = text.trim();
  if (!trimmed) return { vi: "", en: "" };

  const base = (process.env.AI_SERVICE_URL || "http://localhost:3004").replace(
    /\/$/,
    "",
  );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authorization) headers.Authorization = authorization;

  try {
    const res = await fetch(`${base}/api/v1/chat/translate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: trimmed }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as TranslationResult;
    return { vi: data.vn ?? "", en: data.en ?? "" };
  } catch {
    return { vi: trimmed, en: trimmed };
  }
}
