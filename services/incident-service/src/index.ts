import "dotenv/config";
import express, { Application } from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { mountOpenApi, routeModulesFrom } from "@da2/express-swagger";
import { OPENAPI_ROUTE_MODELS } from "./openapi/route-models";
import reportRoutes from "./modules/report/report.routes";
import campaignRoutes from "./modules/campaign/campaign.routes";
import voteRoutes from "./modules/vote/vote.routes";
import savedResourceRoutes from "./modules/saved_resource/saved_resource.routes";
import organizationRoutes from "./modules/organization/organization.routes";
import adminMediaRoutes from "./modules/admin_media/admin-media.routes";
import { errorHandler } from "./middleware/error.middleware";
import {
  camelCaseRequestBody,
  snakeCaseResponseBody,
} from "./middleware/case-transform.middleware";
import "./worker";

const app: Application = express();
const PORT = Number(process.env.PORT) || 3001;
const swaggerRouteFiles = routeModulesFrom(__dirname, [
  "modules/report/report.routes",
  "modules/campaign/campaign.routes",
  "modules/vote/vote.routes",
  "modules/saved_resource/saved_resource.routes",
  "modules/organization/organization.routes",
  "modules/admin_media/admin-media.routes", 
]);

// Middleware
app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);

mountOpenApi(app, {
  title: "Incident service",
  description: "Reports and campaigns",
  serverUrl: process.env.SWAGGER_SERVER_URL || `http://localhost:${PORT}`,
  routeFiles: swaggerRouteFiles,
  typescript: {
    projectRoot: path.join(__dirname, ".."),
    tsconfigPath: path.join(__dirname, "..", "tsconfig.json"),
    routeModels: OPENAPI_ROUTE_MODELS,
  },
});
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(camelCaseRequestBody);
app.use(snakeCaseResponseBody);

// Health check endpoint
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "incident-service" });
});

// Routes
app.use("/api/v1/reports", reportRoutes);
app.use("/api/v1/campaigns", campaignRoutes);
app.use("/api/v1/incident/votes", voteRoutes);
app.use("/incident/saved-resources", savedResourceRoutes);
app.use("/api/v1/organizations", organizationRoutes);
app.use("/api/v1/admin/media", adminMediaRoutes);

// Error handling
app.use(errorHandler);

// Bind all interfaces so Kubernetes http probes (pod IPv4) reach the server.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Incident service running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || "development"}`);
});

export default app;
