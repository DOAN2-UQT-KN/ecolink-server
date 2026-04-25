import "dotenv/config";
import express, { Application } from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import {
  mountOpenApi,
  routeModulesFrom,
} from "@da2/express-swagger";
import { OPENAPI_ROUTE_MODELS } from "./openapi/route-models";
import authRoutes from "./modules/auth/auth.routes";
import userRoutes from "./modules/user/user.routes";
import roleRoutes from "./modules/role/role.routes";
import { caseTransformMiddleware } from "./middleware/case-transform.middleware";
import { errorHandler } from "./middleware/error.middleware";
import internalRoutes from "./internal/internal.routes";

const app: Application = express();
const PORT = process.env.PORT || 3000;
const swaggerRouteFiles = routeModulesFrom(__dirname, [
  "modules/auth/auth.routes",
  "modules/user/user.routes",
  "modules/role/role.routes",
]);

// Middleware
app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);

mountOpenApi(app, {
  title: "Identity service",
  description: "Auth, users, and roles (RBAC)",
  serverUrl:
    process.env.SWAGGER_SERVER_URL || `http://localhost:${PORT}`,
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
app.use(caseTransformMiddleware);

// Health check endpoint
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "identity-service" });
});

app.use("/internal/v1", internalRoutes);

// Routes
app.use("/auth", authRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/roles", roleRoutes);

// Error handling
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Identity service running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || "development"}`);
});

export default app;
