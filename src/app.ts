import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { clientOrigins } from "./config/env";
import { connectDB } from "./config/db";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { requireApiKey } from "./middleware/auth";
import adminRoutes from "./routes/admin";
import authRoutes from "./routes/auth";
import { buildPublicRouter } from "./routes/public";
import systemRoutes from "./routes/system";
import { buildV1Router } from "./routes/v1";

const app = express();
app.set("trust proxy", 1);
app.use(helmet());

// Browser origins (our Next.js app). Third-party API (/api/v1) accepts any origin because it is key-protected.
const webCors = cors({ origin: clientOrigins, credentials: true });
const openCors = cors({ origin: true });
app.use("/api/v1", openCors);
app.use((req, res, next) => (req.path.startsWith("/api/v1") ? next() : webCors(req, res, next)));

app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = buf; // needed for Paystack webhook signature
    },
  }),
);

// Open the DB connection lazily per (cold) invocation.
app.use(async (_req, _res, next) => {
  await connectDB();
  next();
});

const limiter = (windowMs: number, limit: number) => rateLimit({ windowMs, limit, standardHeaders: "draft-7", legacyHeaders: false });

app.use("/api", systemRoutes);
app.use("/api/auth/login", limiter(15 * 60_000, 20));
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/public", limiter(60_000, 120), buildPublicRouter("web"));
app.use("/api/v1", limiter(60_000, 300), requireApiKey, buildV1Router());

app.get("/", (_req, res) => res.json({ success: true, data: { name: "LFF Accommodation API", docs: "See API.md" } }));
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
