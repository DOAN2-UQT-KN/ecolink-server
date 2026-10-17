// Response fields follow Goong's docs (Google-like); verified against the live API in specs/006 T151.
import axios from "axios";

export class GoongError extends Error {
  constructor(readonly status: string) {
    super(`Goong request failed: ${status}`);
    this.name = "GoongError";
  }
}

export interface GoongPrediction {
  placeId: string;
  mainText: string;
  description: string;
}

export interface GoongPoint {
  name: string;
  lat: number;
  lng: number;
}

export interface GoongClient {
  autocomplete(
    q: { input: string; lat: number; lng: number; radiusKm: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<GoongPrediction[]>;
  placeDetail(placeId: string, signal?: AbortSignal): Promise<GoongPoint | null>;
  geocode(lat: number, lng: number, signal?: AbortSignal): Promise<GoongPoint | null>;
}

async function get<T>(path: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<T> {
  const apiKey = process.env.GOONG_API_KEY?.trim();
  if (!apiKey) throw new Error("GOONG_API_KEY is not configured");
  const base = (process.env.GOONG_API_BASE_URL || "https://rsapi.goong.io").replace(/\/$/, "");
  const { data } = await axios.get<T & { status?: string }>(`${base}${path}`, {
    params: { ...params, api_key: apiKey },
    signal,
  });
  if (data?.status && data.status !== "OK" && data.status !== "ZERO_RESULTS") throw new GoongError(data.status);
  return data;
}

const finite = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);

/** Goong REST (Place AutoComplete / Detail, Geocode). Server-side key only (specs/006 FR-030). */
export const goongClient: GoongClient = {
  async autocomplete({ input, lat, lng, radiusKm, limit = 10 }, signal) {
    const data = await get<{
      predictions?: { place_id?: string; description?: string; structured_formatting?: { main_text?: string } }[];
    }>("/Place/AutoComplete", { input, location: `${lat},${lng}`, radius: radiusKm, limit }, signal);
    return (data.predictions ?? [])
      .filter((p) => p.place_id)
      .map((p) => ({
        placeId: p.place_id as string,
        mainText: p.structured_formatting?.main_text ?? p.description ?? "",
        description: p.description ?? "",
      }));
  },

  async placeDetail(placeId, signal) {
    const data = await get<{ result?: { name?: string; geometry?: { location?: { lat?: number; lng?: number } } } }>(
      "/Place/Detail",
      { place_id: placeId },
      signal,
    );
    const lat = finite(data.result?.geometry?.location?.lat);
    const lng = finite(data.result?.geometry?.location?.lng);
    return lat === null || lng === null ? null : { name: data.result?.name ?? "", lat, lng };
  },

  async geocode(lat, lng, signal) {
    const data = await get<{
      results?: { formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }[];
    }>("/Geocode", { latlng: `${lat},${lng}` }, signal);
    const first = data.results?.[0];
    const rLat = finite(first?.geometry?.location?.lat);
    const rLng = finite(first?.geometry?.location?.lng);
    return !first || rLat === null || rLng === null ? null : { name: first.formatted_address ?? "", lat: rLat, lng: rLng };
  },
};
