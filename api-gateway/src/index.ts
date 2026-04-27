import express from "express";
import proxy from "express-http-proxy";
import helmet from "helmet";
import cors from "cors";
import dotenv from "dotenv";
import { mountGatewaySwaggerUi } from "@da2/express-swagger";

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 8081;

const IDENTITY_SERVICE_URL =
  process.env.IDENTITY_SERVICE_URL || "http://localhost:3000";
const INCIDENT_SERVICE_URL =
  process.env.INCIDENT_SERVICE_URL || "http://localhost:3001";
const REWARD_SERVICE_URL =
  process.env.REWARD_SERVICE_URL || "http://localhost:3002";
const AI_SERVICE_URL =
  process.env.AI_SERVICE_URL || "http://localhost:3004";
const GATEWAY_PUBLIC_URL =
  process.env.GATEWAY_PUBLIC_URL || `http://localhost:${port}`;

console.log("🚀 API Gateway starting...");
console.log(
  `🔗 IDENTITY_SERVICE_URL=${IDENTITY_SERVICE_URL} INCIDENT_SERVICE_URL=${INCIDENT_SERVICE_URL} REWARD_SERVICE_URL=${REWARD_SERVICE_URL} AI_SERVICE_URL=${AI_SERVICE_URL}`,
);

app.use(
  cors({
    origin: "*",
    credentials: true,
  }),
);

app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);

async function serveRewrittenOpenApi(
  res: express.Response,
  upstreamBase: string,
): Promise<void> {
  const base = upstreamBase.replace(/\/$/, "");
  const openApiUrl = `${base}/openapi.json`;
  let r: Response;
  try {
    r = await fetch(openApiUrl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[openapi proxy] fetch failed: ${openApiUrl} — ${msg}`);
    res.status(502).json({
      error: "Upstream OpenAPI unreachable",
      upstream: openApiUrl,
      cause: msg,
    });
    return;
  }
  if (!r.ok) {
    console.error(
      `[openapi proxy] ${openApiUrl} returned HTTP ${r.status} ${r.statusText}`,
    );
    res
      .status(502)
      .json({ error: "Upstream OpenAPI unavailable", status: r.status });
    return;
  }
  const doc = (await r.json()) as { servers?: unknown };
  doc.servers = [{ url: GATEWAY_PUBLIC_URL.replace(/\/$/, "") }];
  res.json(doc);
}

// Spec JSON must be registered before Swagger UI mounts on /api-docs
app.get("/api-docs/specs/identity.json", async (req, res, next) => {
  try {
    await serveRewrittenOpenApi(res, IDENTITY_SERVICE_URL);
  } catch (e) {
    next(e);
  }
});

app.get("/api-docs/specs/incident.json", async (req, res, next) => {
  try {
    await serveRewrittenOpenApi(res, INCIDENT_SERVICE_URL);
  } catch (e) {
    next(e);
  }
});

mountGatewaySwaggerUi(app, {
  specs: [
    { name: "Identity", url: "/api-docs/specs/identity.json" },
    { name: "Incident", url: "/api-docs/specs/incident.json" },
  ],
});

// Health check endpoint
app.get("/health", (_req, res) => {
  console.log("Health check requested");
  return res.status(200).json({ status: "UP", service: "api-gateway" });
});

// Proxy routes — Identity
app.use(
  "/api/v1/auth",
  proxy(IDENTITY_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/auth${req.url}`,
  }),
);

app.use(
  "/api/v1/users",
  proxy(IDENTITY_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/users${req.url}`,
  }),
);

app.use(
  "/api/v1/roles",
  proxy(IDENTITY_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/roles${req.url}`,
  }),
);

// Proxy routes — Incident
app.use(
  "/api/v1/reports",
  proxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/reports${req.url}`,
  }),
);

app.use(
  "/api/v1/campaigns",
  proxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/campaigns${req.url}`,
  }),
);

app.use(
  "/api/v1/organizations",
  proxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/organizations${req.url}`,
  }),
);

app.use(
  "/api/v1/admin/media",
  proxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/admin/media${req.url}`,
  }),
);

app.use(
  "/api/v1/incident/votes",
  proxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/incident/votes${req.url}`,
  }),
);

app.use(
  "/api/v1/incident/saved-resources",
  proxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/incident/saved-resources${req.url}`,
  }),
);

// Proxy routes — Reward (gifts, difficulties, …)
app.use(
  "/api/v1/gifts",
  proxy(REWARD_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/gifts${req.url}`,
  }),
);

// Chat / LLM agents (Python ai-service) — SSE; avoid buffering upstream
app.use(
  "/api/v1/chat",
  proxy(AI_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/chat${req.url}`,
    parseReqBody: false,
  }),
);

// Error handling
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("Gateway Error:", err);
    res.status(502).json({
      error: "Bad Gateway",
      message: "The upstream service is unavailable",
    });
  },
);

app.listen(port, () => {
  console.log(`⚡️ API Gateway running on port ${port}`);
  console.log(`📘 Unified API docs: ${GATEWAY_PUBLIC_URL}/api-docs`);
});
