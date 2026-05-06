import type { Prisma } from "@prisma/client";
import type { MetricMetadataService } from "./metric-metadata.service";

const ALLOWED_AGG = new Set(["COUNT", "SUM"]);
const ALLOWED_OPERATORS = new Set([
  "gt",
  "gte",
  "lt",
  "lte",
  "eq",
  "neq",
]);

export type ParsedRuleLeaf = {
  target: string;
  agg: string;
  field: string;
  operator: string;
  value: number;
};

/** Walk rules AST and collect leaf condition nodes. */
export function extractRuleLeaves(node: unknown): ParsedRuleLeaf[] {
  const out: ParsedRuleLeaf[] = [];

  function walk(n: unknown): void {
    if (n === null || n === undefined) return;
    if (typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const o = n as Record<string, unknown>;

    if (Array.isArray(o.conditions)) {
      for (const c of o.conditions) walk(c);
      return;
    }

    if (typeof o.target === "string" && typeof o.field === "string") {
      const agg = typeof o.agg === "string" ? o.agg.toUpperCase() : "";
      const operator = typeof o.operator === "string" ? o.operator.toLowerCase() : "";
      const rawVal = o.value;
      const value =
        typeof rawVal === "number" && Number.isFinite(rawVal)
          ? rawVal
          : typeof rawVal === "string" && rawVal.trim() !== ""
            ? Number(rawVal)
            : NaN;

      out.push({
        target: o.target,
        agg,
        field: o.field,
        operator,
        value,
      });
    }
  }

  walk(node);
  return out;
}

function validateLeafShape(leaf: ParsedRuleLeaf): string | null {
  if (!ALLOWED_AGG.has(leaf.agg)) {
    return "metric_invalid_agg";
  }
  if (!ALLOWED_OPERATORS.has(leaf.operator)) {
    return "metric_invalid_operator";
  }
  if (!Number.isFinite(leaf.value)) {
    return "metric_invalid_value";
  }
  return null;
}

/**
 * Ensure every leaf `target` / `field` exists in metric metadata (active rows).
 * Does not interpret aggregation semantics beyond basic agg/op/value shape checks.
 */
export async function validateRulesConfigAgainstMetricMetadata(
  svc: MetricMetadataService,
  rulesConfig: Prisma.InputJsonValue | null | undefined,
): Promise<string | null> {
  if (rulesConfig === undefined || rulesConfig === null) {
    return null;
  }

  const leaves = extractRuleLeaves(rulesConfig as unknown);
  if (leaves.length === 0) {
    return null;
  }

  const index = await svc.loadActiveMetricIndex();

  for (const leaf of leaves) {
    const shapeErr = validateLeafShape(leaf);
    if (shapeErr) {
      return shapeErr;
    }

    const colKeys = index.get(leaf.target);
    if (!colKeys) {
      return "metric_unknown_table";
    }
    if (!colKeys.has(leaf.field)) {
      return "metric_unknown_column";
    }
  }

  return null;
}
