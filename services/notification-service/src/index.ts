import express, { Application } from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { mountOpenApi, routeModulesFrom } from "@da2/express-swagger";
import { OPENAPI_ROUTE_MODELS } from "./openapi/route-models";
import notificationRoutes from "./modules/notification/notification.routes";
import { errorHandler } from "./middleware/error.middleware";
import "./worker";

dotenv.config();

const app: Application = express();
const PORT = Number(process.env.PORT) || 3003;

const swaggerRouteFiles = routeModulesFrom(__dirname, [
  "modules/notification/notification.routes",
]);

app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);

mountOpenApi(app, {
  title: "Notification service",
  description:
    "Enqueue notification jobs (SQS); worker delivers email and in-app notifications using Handlebars templates",
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

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "notification-service" });
});

app.use("/api/v1/notifications", notificationRoutes);

app.use(errorHandler);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Notification service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});

export default app;
