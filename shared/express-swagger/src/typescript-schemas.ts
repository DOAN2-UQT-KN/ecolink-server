import fs from "fs";
import path from "path";
import { createGenerator } from "ts-json-schema-generator";

export type OpenapiRouteModel = {
  /** TypeScript `export interface` name for JSON request body */
  requestBody?: string;
  /** TypeScript interface for query string (object fields → query params) */
  query?: string;
  /** TypeScript interface matching the `data` field in sendSuccess(..., data) */
  responseData?: string;
  /** Success response has no `data` property */
  omitData?: boolean;
};

export type OpenapiRouteModels = Record<string, OpenapiRouteModel>;

function routeLookupKey(method: string, expressPath: string): string {
  return `${method.toUpperCase()} ${expressPath}`;
}

/** First declaration wins (avoid duplicate interface names across files). */
export function discoverExportedInterfaceTypes(srcRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === "dist") continue;
        walk(full);
      } else if (
        ent.isFile() &&
        (ent.name.endsWith(".dto.ts") || ent.name.endsWith(".openapi.dto.ts"))
      ) {
        const content = fs.readFileSync(full, "utf8");
        const re = /export\s+interface\s+(\w+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          if (!map.has(m[1])) map.set(m[1], full);
        }
      }
    }
  };
  walk(srcRoot);
  return map;
}

function stripJsonSchemaMeta(schema: Record<string, unknown>): void {
  delete schema.$schema;
  delete schema.$id;
}

function extractDefinitions(
  raw: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const defs: Record<string, Record<string, unknown>> = {};
  const d = raw.definitions as Record<string, Record<string, unknown>> | undefined;
  const dd = raw.$defs as Record<string, Record<string, unknown>> | undefined;
  if (d) {
    for (const [k, v] of Object.entries(d)) {
      if (v && typeof v === "object") {
        defs[k] = { ...(v as Record<string, unknown>) };
        stripJsonSchemaMeta(defs[k]);
      }
    }
  }
  if (dd) {
    for (const [k, v] of Object.entries(dd)) {
      if (!defs[k] && v && typeof v === "object") {
        defs[k] = { ...(v as Record<string, unknown>) };
        stripJsonSchemaMeta(defs[k]);
      }
    }
  }
  return defs;
}

/** OpenAPI 3 uses #/components/schemas/*; ts-json-schema emits #/definitions/* or #/$defs/*. */
export function rewriteRefsToOpenapiComponents(node: unknown): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) rewriteRefsToOpenapiComponents(x);
    return;
  }
  const o = node as Record<string, unknown>;
  if (typeof o.$ref === "string") {
    const r = o.$ref;
    if (r.startsWith("#/definitions/")) {
      o.$ref = "#/components/schemas/" + r.slice("#/definitions/".length);
    } else if (r.startsWith("#/$defs/")) {
      o.$ref = "#/components/schemas/" + r.slice("#/$defs/".length);
    }
  }
  for (const v of Object.values(o)) {
    rewriteRefsToOpenapiComponents(v);
  }
}

function createRawSchema(
  projectRoot: string,
  tsconfigPath: string,
  typeName: string,
  typeFileHint: string | undefined,
): Record<string, unknown> | null {
  try {
    const srcPath = path.join(projectRoot, "src");
    const generator = createGenerator({
      path: typeFileHint ?? srcPath,
      tsconfig: tsconfigPath,
      type: typeName,
      skipTypeCheck: true,
      topRef: false,
    });
    const raw = generator.createSchema(typeName) as Record<string, unknown>;
    stripJsonSchemaMeta(raw);
    return raw;
  } catch (e) {
    console.warn(
      `[express-swagger] Could not generate schema for "${typeName}":`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

export function generateJsonSchemaForType(
  projectRoot: string,
  tsconfigPath: string,
  typeName: string,
  typeFileHint: string | undefined,
): Record<string, unknown> | null {
  let loc = new Map<string, string>();
  if (typeFileHint) loc.set(typeName, typeFileHint);
  else {
    loc = discoverExportedInterfaceTypes(path.join(projectRoot, "src"));
  }
  const merged = generateAllComponentSchemas(
    projectRoot,
    tsconfigPath,
    [typeName],
    loc,
  );
  return merged[typeName] ?? null;
}

export function generateAllComponentSchemas(
  projectRoot: string,
  tsconfigPath: string,
  typeNames: Iterable<string>,
  typeLocations: Map<string, string>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const extractedDefs: Record<string, Record<string, unknown>> = {};

  for (const name of typeNames) {
    const hint = typeLocations.get(name);
    const raw = createRawSchema(projectRoot, tsconfigPath, name, hint);
    if (!raw) continue;

    const defs = extractDefinitions(raw);
    for (const [k, v] of Object.entries(defs)) {
      if (!extractedDefs[k]) extractedDefs[k] = v;
    }

    const root = { ...raw } as Record<string, unknown>;
    delete root.definitions;
    delete root.$defs;
    stripJsonSchemaMeta(root);
    out[name] = root;
  }

  for (const [k, v] of Object.entries(extractedDefs)) {
    if (!out[k]) out[k] = v;
  }

  for (const schema of Object.values(out)) {
    rewriteRefsToOpenapiComponents(schema);
  }

  return out;
}

function isObjectSchema(s: Record<string, unknown>): boolean {
  return s.type === "object" || !!s.properties;
}

/** Turn a JSON Schema object type into OpenAPI query parameters. */
export function objectSchemaToQueryParameters(
  schema: Record<string, unknown>,
): Record<string, unknown>[] {
  if (!isObjectSchema(schema)) return [];
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );
  const params: Record<string, unknown>[] = [];
  for (const [name, prop] of Object.entries(props)) {
    const paramSchema = { ...prop };
    delete paramSchema.description;
    params.push({
      name,
      in: "query",
      required: required.has(name),
      schema: simplifySchemaForParameter(paramSchema),
      ...(prop.description ? { description: String(prop.description) } : {}),
    });
  }
  return params;
}

function simplifySchemaForParameter(
  s: Record<string, unknown>,
): Record<string, unknown> {
  if (Array.isArray(s.anyOf)) {
    const nonNull = (s.anyOf as Record<string, unknown>[]).filter(
      (x) => x.type !== "null",
    );
    if (nonNull.length === 1) return simplifySchemaForParameter(nonNull[0]);
  }
  const out: Record<string, unknown> = {};
  if (s.type !== undefined) out.type = s.type;
  if (s.enum !== undefined) out.enum = s.enum;
  if (s.format !== undefined) out.format = s.format;
  if (s.minimum !== undefined) out.minimum = s.minimum;
  if (s.maximum !== undefined) out.maximum = s.maximum;
  if (s.items !== undefined) out.items = s.items;
  if (Object.keys(out).length === 0) return { type: "string" };
  return out;
}

export function successEnvelopeSchema(
  dataRefOrSchema: { $ref: string } | Record<string, unknown> | null,
  omitData: boolean,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    success: { type: "boolean", enum: [true] },
    code: { type: "string" },
    message: { type: "string" },
  };
  const required = ["success", "code", "message"];
  if (!omitData) {
    if (dataRefOrSchema && "$ref" in dataRefOrSchema) {
      props.data = dataRefOrSchema;
    } else if (dataRefOrSchema) {
      props.data = dataRefOrSchema;
    } else {
      props.data = { type: "object", additionalProperties: true };
    }
    required.push("data");
  }
  return {
    type: "object",
    required,
    properties: props,
  };
}

export function collectTypesFromRouteModels(
  models: OpenapiRouteModels,
): Set<string> {
  const names = new Set<string>();
  for (const m of Object.values(models)) {
    if (m.requestBody) names.add(m.requestBody);
    if (m.query) names.add(m.query);
    if (m.responseData) names.add(m.responseData);
  }
  return names;
}

export { routeLookupKey };
