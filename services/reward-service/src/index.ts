import express, { Application } from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { mountOpenApi, routeModulesFrom } from "@da2/express-swagger";
import { OPENAPI_ROUTE_MODELS } from "./openapi/route-models";
import internalRoutes from "./internal/internal.routes";
import difficultyApiRoutes from "./modules/difficulty/difficulty.api.routes";
import giftApiRoutes from "./modules/gift/gift.api.routes";
import userPointsApiRoutes from "./modules/user-points/user-points.api.routes";
import gamificationApiRoutes from "./modules/gamification/gamification.api.routes";
import metricsApiRoutes from "./modules/metrics/metrics.api.routes";
import { errorHandler } from "./middleware/error.middleware";
import "./worker";

dotenv.config();

const app: Application = express();
const PORT = Number(process.env.PORT) || 3002;

mountOpenApi(app, {
  title: "Reward service",
  description:
    "Campaign difficulties, gift redemptions, green points, seasonal RP (CRP/VRP), SP wallet, leaderboards, badges, metric metadata for badge rules, admin gamification config",
  serverUrl: process.env.SWAGGER_SERVER_URL || `http://localhost:${PORT}`,
  routeFiles: routeModulesFrom(__dirname, [
    "modules/difficulty/difficulty.api.routes",
    "modules/gift/gift.api.routes",
    "modules/user-points/user-points.api.routes",
    "modules/gamification/gamification.api.routes",
    "modules/metrics/metrics.api.routes",
  ]),
  typescript: {
    projectRoot: path.join(__dirname, ".."),
    tsconfigPath: path.join(__dirname, "..", "tsconfig.json"),
    routeModels: OPENAPI_ROUTE_MODELS,
  },
});

app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);
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
  res.status(200).json({ status: "ok", service: "reward-service" });
});

app.use("/api/v1", difficultyApiRoutes);
app.use("/api/v1", giftApiRoutes);
app.use("/api/v1", userPointsApiRoutes);
app.use("/api/v1", metricsApiRoutes);
app.use("/api/v1", gamificationApiRoutes);
app.use("/internal/v1", internalRoutes);

app.use(errorHandler);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Reward service listening on ${PORT}`);
});

export default app;
