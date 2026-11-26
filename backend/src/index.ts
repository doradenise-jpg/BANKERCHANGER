import { randomUUID } from "node:crypto";
import express from "express";
import pinoHttp from "pino-http";
import { validateEnv } from "./config/env";
// Validate environment variables first before importing anything else that uses them!
const env = validateEnv();

import { version } from '../package.json';

import { createCorsMiddleware } from "./config/cors";
import { setupSwagger } from "./config/swagger";
import { errorMiddleware } from "./middleware/error.middleware";
import { requireAdmin } from "./middleware/admin.middleware";
import { initSentry, applySentryRequestHandler } from "./middleware/sentry.middleware";
import { rateLimit } from "./middleware/rate-limit.middleware";
import { requestLogging } from "./middleware/request-logging.middleware";
import { requestContextMiddleware } from "./middleware/request-context.middleware";
import { AppError } from "./utils/AppError";
import { logger } from "./utils/logger";
import { pool } from "./config/db";
import { redis } from "./config/redis";
import { requireAdminJwt } from "./middleware/requireAdminJwt.middleware";
import authRouter from "./routes/auth.routes";
import marketRouter from "./routes/market.routes";
import governanceRouter from "./routes/governance.routes";
import usersRouter from "./routes/users.routes";
import adminRouter from "./routes/admin.routes";
import operationsRouter from "./routes/operations.routes";
import { register, httpRequestDuration, httpRequestsTotal } from "./services/metrics.service";

import disputesRouter from "./routes/disputes.routes";
import oracleRouter from "./routes/oracle.routes";
import walletsRouter from "./routes/wallets.routes";
import notificationsRouter from "./routes/notifications.routes";
import leaderboardRouter from "./routes/leaderboard.routes";
import engagementRouter from "./routes/engagement.routes";
import { getPortfolio, getPortfolioRoi, getPlatformStats } from "./api/controllers/MarketController";
import claimsRouter from "./routes/bet.routes";
import { startAutoResolutionCron, startAutoLockCron } from "./cron/autoResolution.cron";
import { startCleanupCron } from "./cron/cleanup.cron";
import { startWebhookDeliveryCron } from "./cron/webhookDelivery.cron";
import { initActivityFeed, getActivityFeed } from "./websocket/realtime";
import { engagementService } from "./services/engagement.service";

import { setDbAdapter, defaultDbAdapter } from "./services/MarketService";

// Initialise Sentry before any other code (captures unhandled rejections/exceptions)
initSentry(env.SENTRY_DSN, env.NODE_ENV);

// Wire default production DbAdapter for MarketService
setDbAdapter(defaultDbAdapter);

const app = express();

// CORS configuration - must be before other middleware
app.use(createCorsMiddleware());

// Logging middleware — must run first so every request (and every log line
// emitted downstream) carries a request_id for tracing.
app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const existing = req.headers["x-request-id"];
      const id =
        (typeof existing === "string" && existing) ||
        (Array.isArray(existing) && existing[0]) ||
        randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
  }),
);
app.use(requestContextMiddleware);
app.use(express.json());
app.use(requestLogging);

// Setup Swagger/OpenAPI documentation
if (env.NODE_ENV === 'development' || env.ENABLE_SWAGGER) {
  setupSwagger(app);
}

// Prometheus metrics endpoint (internal only — no auth required)
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// HTTP request metrics middleware
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    const route = req.route?.path || req.path;
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
});

// Routes
// Public health endpoint — returns no internal service or version details.
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    await redis.ping();
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
    });
  }
});

// Detailed health endpoint (Issue #682) — restricted to admin JWT
app.get("/health/detailed", requireAdminJwt, async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    await redis.ping();
    res.json({
      status: "healthy",
      version,
      timestamp: new Date().toISOString(),
      db: "connected",
      redis: "connected",
      dbPool: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      },
    });
  } catch {
    res.status(503).json({
      status: "unhealthy",
      version,
      timestamp: new Date().toISOString(),
    });
  }
});

// Rate-limited route groups
app.use("/auth", rateLimit({ windowMs: 60_000, max: 10, keyBy: "ip" }));
app.use("/api", healthRouter);
app.use("/api", rateLimit({ windowMs: 60_000, max: 60, keyBy: "ip" })); // Public endpoints
app.use("/api/oracle", rateLimit({ windowMs: 60_000, max: 10, keyBy: "ip" })); // Oracle endpoint stricter
app.use("/api/admin", rateLimit({ windowMs: 60_000, max: 20, keyBy: "ip" })); // Admin endpoints
app.use("/trading", rateLimit({ windowMs: 60_000, max: 60, keyBy: "userId" }));
app.use(
  "/wallet/withdraw",
  rateLimit({ windowMs: 60_000, max: 5, keyBy: "userId" }),
);

app.use("/auth", authRouter);
app.use("/api/markets", marketRouter);
app.use("/api/governance", governanceRouter);
app.use("/api/engagement", engagementRouter);
app.use("/api/claims", claimsRouter);
app.use("/api/bets", claimsRouter);
app.get("/api/stats", getPlatformStats);
app.get("/api/portfolio/:address/roi", getPortfolioRoi);
app.get("/api/portfolio/:address", getPortfolio);
app.use("/api/users", usersRouter);
app.use("/api/disputes", disputesRouter);
app.use("/api/oracle", oracleRouter);
app.use("/api/wallets", walletsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/leaderboard", leaderboardRouter);
app.use("/api/admin", adminRouter);
app.use(operationsRouter);

// 404 handler - must be before error middleware
app.use((_req, _res, next) => {
  next(AppError.notFound("Route not found"));
});

// Sentry error handler - must be before errorMiddleware
applySentryRequestHandler(app);

// Error handler - must be LAST
app.use(errorMiddleware);

if (require.main === module) {
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "Server running");
    if (env.NODE_ENV === 'development' || env.ENABLE_SWAGGER) {
      logger.info({ port: env.PORT }, "Swagger UI available");
    }
    startAutoResolutionCron();
    startAutoLockCron();
    startCleanupCron();
    startWebhookDeliveryCron();
  });

  // Startup health check — catch misconfigured env vars or failed connections early
  void (async () => {
    const results: string[] = [];
    try {
      await pool.query("SELECT 1");
      results.push("db: ok");
    } catch (err) {
      logger.error({ err }, "Startup health check FAILED — database unreachable");
      results.push("db: FAILED");
    }
    try {
      await redis.ping();
      results.push("redis: ok");
    } catch (err) {
      logger.error({ err }, "Startup health check FAILED — redis unreachable");
      results.push("redis: FAILED");
    }
    logger.info({ results }, "Startup health check complete");
  })();

  initActivityFeed(server, redis);
  engagementService.setRankUpdateListener((updates) => {
    try {
      getActivityFeed().emitLeaderboardRankUpdate(updates);
    } catch (err) {
      logger.warn({ err }, "Failed to emit leaderboard rank update");
    }
  });
}

export default app;
