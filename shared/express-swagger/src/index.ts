import fs from "fs";
import path from "path";
import type { Application, Request, Response } from "express";
import swaggerUi from "swagger-ui-express";
import {
  collectTypesFromRouteModels,
  discoverExportedInterfaceTypes,
  generateAllComponentSchemas,
  objectSchemaToQueryParameters,
  routeLookupKey,
  successEnvelopeSchema,
  type OpenapiRouteModels,
} from "./typescript-schemas";

export type { OpenapiRouteModel, OpenapiRouteModels } from "./typescript-schemas";

export type MountOpenApiOptions = {
  title: string;
  version?: string;
  description?: string;
  /** Public base URL for Try it out (e.g. http://localhost:3000) */
  serverUrl: string;
  /** Absolute paths to route modules (.ts under ts-node, .js under node dist) */
  routeFiles: string[];
  /**
   * When set, request/response/query shapes are generated from TypeScript interfaces
   * under `projectRoot/src` (see `*.dto.ts`, `openapi-envelope.dto.ts`).
   */
  typescript?: {
    projectRoot: string;
    tsconfigPath: string;
    routeModels: OpenapiRouteModels;
  };
};

function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** Path segments like `/api/v1/reports/{id}` → OpenAPI path parameters */
function pathParametersFor(openapiPath: string): Record<string, unknown>[] {
  const names = [...openapiPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
      description: `Path parameter \`${name}\``,
    });
  }
  return out;
}

function methodUsesJsonBody(method: string): boolean {
  return method === "post" || method === "put" || method === "patch";
}

function genericJsonRequestBody(): Record<string, unknown> {
  return {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          additionalProperties: true,
          description:
            "Request JSON. Exact fields are enforced by the service (validators/DTOs); this placeholder lets you try calls from Swagger.",
        },
      },
    },
  };
}

type ParsedOp = {
  method: string;
  path: string;
  summary: string;
  secured: boolean;
};

function parseRouteFile(filePath: string): ParsedOp[] {
  const content = fs.readFileSync(filePath, "utf8");
  const results: ParsedOp[] = [];
  const segments = content.split("/**");
  for (const seg of segments) {
    const routeMatch = seg.match(/\* @route\s+(\w+)\s+(\S+)/);
    if (!routeMatch) continue;
    const fullPath = routeMatch[2];
    const descMatch = seg.match(/\* @desc\s+(.+)/);
    const summary = descMatch ? descMatch[1].trim() : fullPath;
    const routerCall = seg.match(
      /router\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/,
    );
    const method = routerCall
      ? routerCall[1].toLowerCase()
      : routeMatch[1].toLowerCase();
    const secured = /\bauthenticate\b/.test(seg);
    results.push({ method, path: fullPath, summary, secured });
  }
  return results;
}

function buildSpec(opts: MountOpenApiOptions): Record<string, unknown> {
  const ts = opts.typescript;
  const componentsSchemas: Record<string, Record<string, unknown>> = {};
  let typeLocations = new Map<string, string>();
  if (ts) {
    typeLocations = discoverExportedInterfaceTypes(path.join(ts.projectRoot, "src"));
    const typeNames = collectTypesFromRouteModels(ts.routeModels);
    Object.assign(
      componentsSchemas,
      generateAllComponentSchemas(
        ts.projectRoot,
        ts.tsconfigPath,
        typeNames,
        typeLocations,
      ),
    );
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const file of opts.routeFiles) {
    if (!fs.existsSync(file)) continue;
    for (const op of parseRouteFile(file)) {
      const p = toOpenApiPath(op.path);
      if (!paths[p]) paths[p] = {};
      const pathParams = pathParametersFor(p);
      const routeKey = routeLookupKey(op.method, op.path);
      const model = ts?.routeModels[routeKey];

      const parameters: Record<string, unknown>[] = [...pathParams];
      if (model?.query && componentsSchemas[model.query]) {
        parameters.push(
          ...objectSchemaToQueryParameters(componentsSchemas[model.query]),
        );
      }

      let requestBody: Record<string, unknown> | undefined;
      if (
        ts &&
        model?.requestBody &&
        componentsSchemas[model.requestBody]
      ) {
        requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: `#/components/schemas/${model.requestBody}`,
              },
            },
          },
        };
      } else if (methodUsesJsonBody(op.method) && (!ts || !model)) {
        requestBody = genericJsonRequestBody();
      }

      let responses: Record<string, unknown>;
      if (ts && model) {
        const innerSchema =
          model.omitData === true
            ? successEnvelopeSchema(null, true)
            : model.responseData && componentsSchemas[model.responseData]
              ? successEnvelopeSchema(
                  { $ref: `#/components/schemas/${model.responseData}` },
                  false,
                )
              : successEnvelopeSchema(null, false);
        const jsonContent = {
          content: {
            "application/json": {
              schema: innerSchema,
            },
          },
        };
        responses = {
          "200": { description: "Success", ...jsonContent },
          "201": { description: "Created", ...jsonContent },
          "204": { description: "No content" },
          default: { description: "Error" },
        };
      } else {
        responses = {
          "200": { description: "Success" },
          "201": { description: "Created" },
          "204": { description: "No content" },
          default: { description: "Error" },
        };
      }

      paths[p][op.method] = {
        summary: op.summary,
        tags: [inferTag(p)],
        ...(op.secured ? { security: [{ bearerAuth: [] }] } : {}),
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(requestBody ? { requestBody } : {}),
        responses,
      };
    }
  }
  return {
    openapi: "3.0.3",
    info: {
      title: opts.title,
      version: opts.version ?? "1.0.0",
      ...(opts.description ? { description: opts.description } : {}),
    },
    servers: [{ url: opts.serverUrl.replace(/\/$/, "") || "/" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      ...(Object.keys(componentsSchemas).length > 0
        ? { schemas: componentsSchemas }
        : {}),
    },
  };
}

function inferTag(apiPath: string): string {
  const parts = apiPath.split("/").filter(Boolean);
  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "v1") {
    const resource = parts[2];
    if (resource === "auth") return "Auth";
    if (resource === "users") return "Users";
    if (resource === "roles") return "Roles";
    if (resource === "reports") return "Reports";
    if (resource === "campaigns") return "Campaigns";
    return resource.charAt(0).toUpperCase() + resource.slice(1);
  }
  return "API";
}

function resolveRouteModule(serviceRoot: string, relWithoutExt: string): string {
  const tsPath = path.join(serviceRoot, `${relWithoutExt}.ts`);
  const jsPath = path.join(serviceRoot, `${relWithoutExt}.js`);
  if (fs.existsSync(tsPath)) return tsPath;
  return jsPath;
}

/**
 * Resolve route file paths relative to the compiled (or source) app root
 * (__dirname from index.ts: `src` with ts-node, `dist` when compiled).
 */
export function routeModulesFrom(
  appDirname: string,
  relatives: string[],
): string[] {
  return relatives.map((r) => resolveRouteModule(appDirname, r));
}

export function mountOpenApi(app: Application, opts: MountOpenApiOptions): void {
  const spec = buildSpec(opts);
  app.get("/openapi.json", (_req: Request, res: Response) => {
    res.json(spec);
  });
  app.use(
    "/api-docs",
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: `${opts.title} — API docs`,
      swaggerOptions: {
        persistAuthorization: true,
        tryItOutEnabled: true,
      },
    }),
  );
}

export type GatewaySwaggerSpec = { name: string; url: string };

/**
 * Unified Swagger UI at /api-docs with a dropdown of specs (typical: one per microservice).
 */
export function mountGatewaySwaggerUi(
  app: Application,
  opts: { specs: GatewaySwaggerSpec[] },
): void {
  if (opts.specs.length === 0) return;
  // Runtime supports swaggerUrls as {url,name}[]; DefinitelyTyped only lists string[]
  const uiOpts = {
    explorer: true,
    swaggerUrls: opts.specs.map((s) => ({ url: s.url, name: s.name })),
  } as unknown as Parameters<typeof swaggerUi.setup>[1];
  app.use(
    "/api-docs",
    swaggerUi.serve,
    swaggerUi.setup(undefined, uiOpts),
  );
}

export { buildSpec, parseRouteFile, toOpenApiPath };
