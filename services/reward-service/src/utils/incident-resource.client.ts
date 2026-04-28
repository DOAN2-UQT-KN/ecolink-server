function getIncidentBaseUrl(): string | null {
  const baseURL = process.env.INCIDENT_SERVICE_URL?.trim();
  if (!baseURL) {
    return null;
  }
  return baseURL.replace(/\/$/, "");
}

function getArrayFromEnvelope(data: unknown, key: string): unknown[] {
  if (!data || typeof data !== "object") {
    return [];
  }

  const root = data as Record<string, unknown>;
  if (root.success === false) {
    return [];
  }

  const inner = root.data;
  if (inner && typeof inner === "object") {
    const value = (inner as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  const topLevel = root[key];
  if (Array.isArray(topLevel)) {
    return topLevel;
  }

  return [];
}

function readId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = (raw as Record<string, unknown>).id;
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return value;
}

export async function fetchCampaignsByIds(
  campaignIds: string[],
  authorization?: string,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const unique = [...new Set(campaignIds.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return out;
  }

  const baseURL = getIncidentBaseUrl();
  if (!baseURL) {
    return out;
  }

  try {
    const params = new URLSearchParams();
    params.set("campaignIds", unique.join(","));
    const headers: Record<string, string> = {};
    if (authorization?.trim()) {
      headers.Authorization = authorization;
    }

    const res = await fetch(`${baseURL}/api/v1/campaigns/by-ids?${params.toString()}`, {
      method: "GET",
      headers,
    });
    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }

    const data = await res.json();
    const campaigns = getArrayFromEnvelope(data, "campaigns");
    for (const item of campaigns) {
      const id = readId(item);
      if (!id || typeof item !== "object" || item === null) {
        continue;
      }
      out.set(id, item as Record<string, unknown>);
    }
  } catch (error) {
    console.error("[incident-resource.client] fetchCampaignsByIds:", error);
  }

  return out;
}

export async function fetchReportsByIds(
  reportIds: string[],
  authorization?: string,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const unique = [...new Set(reportIds.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return out;
  }

  const baseURL = getIncidentBaseUrl();
  if (!baseURL) {
    return out;
  }

  try {
    const params = new URLSearchParams();
    params.set("reportIds", unique.join(","));
    const headers: Record<string, string> = {};
    if (authorization?.trim()) {
      headers.Authorization = authorization;
    }

    const res = await fetch(`${baseURL}/api/v1/reports/by-ids?${params.toString()}`, {
      method: "GET",
      headers,
    });
    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }

    const data = await res.json();
    const reports = getArrayFromEnvelope(data, "reports");
    for (const item of reports) {
      const id = readId(item);
      if (!id || typeof item !== "object" || item === null) {
        continue;
      }
      out.set(id, item as Record<string, unknown>);
    }
  } catch (error) {
    console.error("[incident-resource.client] fetchReportsByIds:", error);
  }

  return out;
}
