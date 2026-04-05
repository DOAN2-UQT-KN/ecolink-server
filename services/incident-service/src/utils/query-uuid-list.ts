import { isUUID } from "validator";

const DEFAULT_MAX_IDS = 100;

export type NormalizeQueryUuidListResult =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "ok"; ids: string[] };

/**
 * Parse repeated query keys or comma-separated UUIDs (?ids=a&ids=b or ?ids=a,b).
 */
export function normalizeQueryUuidList(
  value: unknown,
  max = DEFAULT_MAX_IDS,
): NormalizeQueryUuidListResult {
  if (value === undefined || value === null || value === "") {
    return { kind: "absent" };
  }
  const raw = Array.isArray(value)
    ? value.map((v) => String(v))
    : String(value).split(",");
  const parts = [
    ...new Set(raw.map((s) => s.trim()).filter((s) => s.length > 0)),
  ];
  if (parts.length === 0) {
    return { kind: "absent" };
  }
  if (parts.length > max) {
    return { kind: "invalid" };
  }
  if (!parts.every((id) => isUUID(id))) {
    return { kind: "invalid" };
  }
  return { kind: "ok", ids: parts };
}
