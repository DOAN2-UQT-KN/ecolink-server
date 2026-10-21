import "./tracer";
import express from "express";
import proxy from "express-http-proxy";
import helmet from "helmet";
import cors from "cors";
import dotenv from "dotenv";
import { mountGatewaySwaggerUi } from "@da2/express-swagger";

dotenv.config();

type ProxyOptions = NonNullable<Parameters<typeof proxy>[1]>;

function stripUpstreamCorsHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith("access-control-")) {
      delete headers[key];
    }
  }
  return headers;
}

function gatewayProxy(
  target: string,
  options: ProxyOptions,
): ReturnType<typeof proxy> {
  const { userResHeaderDecorator, ...rest } = options;
  return proxy(target, {
    ...rest,
    userResHeaderDecorator: (headers, userReq, userRes, proxyReq, proxyRes) => {
      const decorated = userResHeaderDecorator
        ? userResHeaderDecorator(
            headers,
            userReq,
            userRes,
            proxyReq,
            proxyRes,
          )
        : headers;
      stripUpstreamCorsHeaders(decorated);
      const origin = userReq.headers.origin;
      if (typeof origin === "string" && origin.length > 0) {
        decorated["access-control-allow-origin"] = origin;
        decorated["access-control-allow-credentials"] = "true";
        decorated.vary = decorated.vary
          ? `${decorated.vary}, Origin`
          : "Origin";
      }
      return decorated;
    },
  });
}

function resolveCorsOrigin(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean | string) => void,
): void {
  const configured = process.env.CORS_ORIGIN?.trim();
  if (!configured || configured === "*") {
    callback(null, origin ?? true);
    return;
  }
  const allowed = configured.split(",").map((value) => value.trim());
  if (!origin || allowed.includes(origin)) {
    callback(null, true);
  } else {
    callback(new Error(`CORS blocked for origin: ${origin}`));
  }
}

const app = express();
const port = Number(process.env.PORT) || 8081;

const IDENTITY_SERVICE_URL =
  process.env.IDENTITY_SERVICE_URL || "http://localhost:4000";
const INCIDENT_SERVICE_URL =
  process.env.INCIDENT_SERVICE_URL || "http://localhost:3001";
const REWARD_SERVICE_URL =
  process.env.REWARD_SERVICE_URL || "http://localhost:3002";
const NOTIFICATION_SERVICE_URL =
  process.env.NOTIFICATION_SERVICE_URL || "http://localhost:3003";
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://localhost:3004";
const GATEWAY_PUBLIC_URL =
  process.env.GATEWAY_PUBLIC_URL || `http://localhost:${port}`;

console.log("🚀 API Gateway starting...");
console.log(
  `🔗 IDENTITY_SERVICE_URL=${IDENTITY_SERVICE_URL} INCIDENT_SERVICE_URL=${INCIDENT_SERVICE_URL} REWARD_SERVICE_URL=${REWARD_SERVICE_URL} NOTIFICATION_SERVICE_URL=${NOTIFICATION_SERVICE_URL} AI_SERVICE_URL=${AI_SERVICE_URL}`,
);

app.use(
  cors({
    origin: resolveCorsOrigin,
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

app.get("/api-docs/specs/reward.json", async (req, res, next) => {
  try {
    await serveRewrittenOpenApi(res, REWARD_SERVICE_URL);
  } catch (e) {
    next(e);
  }
});

app.get("/api-docs/specs/ai.json", async (req, res, next) => {
  try {
    await serveRewrittenOpenApi(res, AI_SERVICE_URL);
  } catch (e) {
    next(e);
  }
});

app.get("/api-docs/specs/notification.json", async (req, res, next) => {
  try {
    await serveRewrittenOpenApi(res, NOTIFICATION_SERVICE_URL);
  } catch (e) {
    next(e);
  }
});

/** Swagger UI; specs proxy each service’s OpenAPI (gateway rewrites servers to GATEWAY_PUBLIC_URL). */
mountGatewaySwaggerUi(app, {
  specs: [
    { name: "Identity", url: "/api-docs/specs/identity.json" },
    { name: "Incident", url: "/api-docs/specs/incident.json" },
    { name: "Reward", url: "/api-docs/specs/reward.json" },
    { name: "Notification", url: "/api-docs/specs/notification.json" },
    { name: "AI", url: "/api-docs/specs/ai.json" },
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
  gatewayProxy(IDENTITY_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/auth${req.url}`,
  }),
);

app.use(
  "/api/v1/users",
  gatewayProxy(IDENTITY_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/users${req.url}`,
  }),
);

app.use(
  "/api/v1/roles",
  gatewayProxy(IDENTITY_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/roles${req.url}`,
  }),
);

// Proxy routes — Incident
app.use(
  "/api/v1/reports",
  gatewayProxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/reports${req.url}`,
  }),
);

app.use(
  "/api/v1/campaigns",
  gatewayProxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/campaigns${req.url}`,
  }),
);

app.use(
  "/api/v1/organizations",
  gatewayProxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/organizations${req.url}`,
  }),
);

app.use(
  "/api/v1/organization-invitations",
  proxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/organization-invitations${req.url}`,
  }),
);

app.use(
  "/api/v1/organization-applications",
  proxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/organization-applications${req.url}`,
  }),
);

app.use(
  "/api/v1/admin/organization-applications",
  proxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) =>
      `/api/v1/admin/organization-applications${req.url}`,
  }),
);

app.use(
  "/api/v1/admin/media",
  gatewayProxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/admin/media${req.url}`,
  }),
);

app.use(
  "/api/v1/incident/votes",
  gatewayProxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/incident/votes${req.url}`,
  }),
);

app.use(
  "/api/v1/incident/saved-resources",
  gatewayProxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/incident/saved-resources${req.url}`,
  }),
);

app.use(
  "/api/v1/sos",
  gatewayProxy(INCIDENT_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/sos${req.url}`,
  }),
);

// Proxy routes — Notification (in-app list, mark read; internal jobs hit service directly with API key)
app.use(
  "/api/v1/notifications",
  gatewayProxy(NOTIFICATION_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/notifications${req.url}`,
  }),
);

// Proxy routes — Reward (gifts, difficulties, points, redemptions, admin point rules)
app.use(
  "/api/v1/gifts",
  gatewayProxy(REWARD_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/gifts${req.url}`,
  }),
);

app.use(
  "/api/v1/difficulties",
  gatewayProxy(REWARD_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/difficulties${req.url}`,
  }),
);

app.use(
  "/api/v1/me/points",
  gatewayProxy(REWARD_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/me/points${req.url}`,
  }),
);

app.use(
  "/api/v1/me/redemptions",
  gatewayProxy(REWARD_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/me/redemptions${req.url}`,
  }),
);

app.use(
  "/api/v1/admin/gift-redemptions",
  gatewayProxy(REWARD_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/admin/gift-redemptions${req.url}`,
  }),
);

app.use(
  "/api/v1/admin/gift-sources",
  gatewayProxy(REWARD_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/admin/gift-sources${req.url}`,
  }),
);

app.use(
  "/api/v1/admin/gifts",
  gatewayProxy(REWARD_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/admin/gifts${req.url}`,
  }),
);

app.use(
  "/api/v1/admin/stock-batches",
  gatewayProxy(REWARD_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/admin/stock-batches${req.url}`,
  }),
);

app.use(
  "/api/v1/admin/gamification",
  gatewayProxy(REWARD_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/admin/gamification${req.url}`,
  }),
);

// Chat / LLM agents (Python ai-service) — SSE; avoid buffering upstream
app.use(
  "/api/v1/chat",
  gatewayProxy(AI_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/chat${req.url}`,
    parseReqBody: false,
  }),
);

// Translation shortcut route -> ai-service translation assistant
app.use(
  "/api/v1/translate",
  gatewayProxy(AI_SERVICE_URL, {
    proxyReqPathResolver: (req) => `/api/v1/chat/translate${req.url}`,
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
